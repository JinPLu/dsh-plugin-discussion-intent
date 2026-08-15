import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-discussion-consumer-'))
const packDirectory = join(temporaryRoot, 'pack')
const dshHome = join(temporaryRoot, 'home')
const workspace = join(temporaryRoot, 'workspace')
const driverPath = join(temporaryRoot, 'consumer-driver.mjs')
const overlayPath = join(temporaryRoot, 'consumer-driver.patch.yml')
const reloadDriverPath = join(temporaryRoot, 'consumer-reload-driver.mjs')
const reloadOverlayPath = join(temporaryRoot, 'consumer-reload-driver.patch.yml')
const dshVersion = process.env.DSH_SMOKE_DSH_VERSION
const dshRepository = process.env.DSH_SMOKE_DSH_REPO
const pluginId = '@jinplu/dsh-plugin-discussion-intent'
const sessionId = 'discussion-consumer-smoke'

function dshArguments(args) {
  if (dshRepository !== undefined && dshRepository !== '') {
    return ['--dir', dshRepository, 'dsh', ...args]
  }
  return dshVersion === undefined || dshVersion === ''
    ? ['exec', 'dsh', ...args]
    : [
        'dlx',
        '--allow-build=node-pty',
        '--allow-build=@deepseek-ai/dsh-subprocess-local',
        '--allow-build=koffi',
        '--allow-build=esbuild',
        `@deepseek-ai/dsh@${dshVersion}`,
        ...args,
      ]
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', rejectPromise)
    child.once('exit', code => {
      if (code === 0) resolvePromise(output)
      else rejectPromise(new Error(`${command} ${args.join(' ')} exited ${String(code)}\n${output}`))
    })
  })
}

async function httpJson(url, timeoutMs = 10_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: response.status, value: JSON.parse(await response.text()) }
}

async function httpText(url, timeoutMs = 10_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`GET ${url} -> ${String(response.status)}`)
  return response.text()
}

async function sseData(url, onEvent) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`GET ${url} -> ${String(response.status)}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('SSE stream closed before the expected events arrived')
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const line = frame.split('\n').find(part => part.startsWith('data: '))
        if (line !== undefined) {
          if (await onEvent(JSON.parse(line.slice('data: '.length)))) return
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/**
 * Boot DSH with the driver overlay, wait for the web boot line and the
 * driver's OK marker, then hand the printed port to `probe` while the process
 * stays alive. Resolves with the output after the probe finishes and the
 * process stops cleanly on SIGINT.
 */
async function bootAndProbe(patchPath, successMarker, failureMarker, probe) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('pnpm', dshArguments(['--profile', 'web', '--patch', patchPath, '--port', '0']), {
      cwd: packageRoot,
      env: { ...process.env, DSH_HOME: dshHome, DISCUSSION_SMOKE_WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let sawBoot = false
    let sawProbe = false
    let probing = false
    let settled = false
    let stopping = false
    let pendingError
    let shutdownTimeout
    const timeout = setTimeout(() => requestShutdown(new Error(`Timed out waiting for DSH consumer smoke.\n${output}`)), 120_000)
    const bootMatch = () => output.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/u)
    function settle(error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout)
      if (error === undefined) resolvePromise(output)
      else rejectPromise(error)
    }
    function requestShutdown(error) {
      if (stopping || settled) return
      stopping = true
      pendingError = error
      clearTimeout(timeout)
      if (child.exitCode !== null) {
        settle(error)
        return
      }
      child.kill('SIGINT')
      shutdownTimeout = setTimeout(() => {
        child.kill('SIGKILL')
        settle(error ?? new Error(`DSH did not stop after SIGINT.\n${output}`))
      }, 10_000)
    }
    function consume(chunk) {
      output += chunk.toString()
      sawBoot ||= bootMatch() !== null
      sawProbe ||= output.includes(successMarker)
      if (failureMarker !== undefined && output.includes(failureMarker)) {
        requestShutdown(new Error(`DSH reload acceptance failed.\n${output}`))
        return
      }
      if (sawBoot && sawProbe && !probing) {
        probing = true
        const match = bootMatch()
        if (match === null) {
          requestShutdown(new Error(`No DSH web port in output.\n${output}`))
          return
        }
        const port = Number(match[1])
        Promise.resolve(probe({ port }))
          .then(() => requestShutdown())
          .catch(error => requestShutdown(error))
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', settle)
    child.once('close', code => {
      if (stopping) settle(pendingError)
      else settle(new Error(`DSH exited ${String(code)} before the smoke completed.\n${output}`))
    })
  })
}

const driverSource = `
export const name = 'discussion-consumer-smoke'
export const inject = ['agents', 'commands', 'discussionIntent', 'sessions', 'tools']

export async function apply(ctx) {
  const cwd = process.env.DISCUSSION_SMOKE_WORKSPACE
  if (!cwd) throw new Error('DISCUSSION_SMOKE_WORKSPACE is missing')
  const session = ctx.sessions.create('discussion-consumer-smoke', { meta: { cwd } })
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    ctx,
    steer(message) { session.append('user/message', message, { surfaceOp: 'append' }) },
  }
  ctx.effect(() => ctx.agents.register(agent))
  const descriptor = ctx.commands.list(agent).find(command => command.name === 'discussion')
  if (descriptor?.input?.hint !== '[1=fast | 2=default | 3=deep | off]') {
    throw new Error('discussion command or clear intensity hint is missing')
  }
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'discussion_update')
  if (!schema || !JSON.stringify(schema).includes('expectedRevision')) {
    throw new Error('discussion_update schema is missing')
  }
  const execution = await ctx.commands.execute(agent, '/discussion 2', new AbortController().signal)
  if (execution?.result?.kind !== 'success') throw new Error('discussion command failed')
  const state = ctx.discussionIntent.get(agent)
  if (!state || state.active !== true || state.intensity !== 2 || state.revision !== 1) {
    throw new Error('discussion state is missing after /discussion')
  }
  if (state.checkpoint.status !== 'saved') throw new Error('discussion Markdown was not saved')
  const markdown = await import('node:fs/promises').then(fs => fs.readFile(state.checkpoint.filePath, 'utf8'))
  if (!markdown.includes('# Topic to be distilled')) throw new Error('discussion Markdown content is incomplete')
  if (session.events.some(item => item.type.startsWith('discussion-intent/'))) {
    throw new Error('plugin leaked a custom session event into the DSH session log')
  }
  console.log('DISCUSSION_CONSUMER_SMOKE_OK')
  // Fire the intensity change after the parent has opened its SSE stream.
  setTimeout(async () => {
    const changed = await ctx.commands.execute(agent, '/discussion 1', new AbortController().signal)
    if (changed?.result?.kind !== 'success') console.error('DISCUSSION_CONSUMER_PUSH_FAILED')
    else console.log('DISCUSSION_CONSUMER_PUSH_OK')
  }, 3_000)
}
`

const reloadDriverSource = `
export const name = 'discussion-consumer-reload-smoke'
export const inject = ['agents', 'discussionIntent', 'sessionPersistence', 'sessions']

export async function apply(ctx) {
  try {
    const preparation = await ctx.sessionPersistence.prepare('discussion-consumer-smoke')
    const session = preparation.session
    const detach = ctx.sessions.enter(session)
    ctx.effect(() => detach)
    ctx.sessions.announce(session)
    preparation[Symbol.dispose]()
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      options: {},
      ctx,
      steer(message) { session.append('user/message', message, { surfaceOp: 'append' }) },
    }
    ctx.effect(() => ctx.agents.register(agent))
    const restored = ctx.discussionIntent.get(agent)
    if (!restored || restored.active !== true || restored.checkpoint.status !== 'saved') {
      throw new Error('reloaded Discussion state is missing')
    }
    if (restored.intensity !== 1) throw new Error('reloaded Discussion did not keep the last intensity')
    const continued = await ctx.discussionIntent.update(agent, {
      expectedRevision: restored.revision,
      provisionalTitle: 'Restored discussion acceptance',
      historySummary: 'Continued after a full DSH restart.',
    })
    if (continued.revision !== restored.revision + 1 || continued.checkpoint.status !== 'saved') {
      throw new Error('reloaded Discussion did not continue and save')
    }
    if (session.events.some(item => item.type.startsWith('discussion-intent/'))) {
      throw new Error('reloaded session log contains a custom session event')
    }
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const workspace = process.env.DISCUSSION_SMOKE_WORKSPACE
    const jsonPath = path.join(workspace, '.dsh/discussions', 'discussion-consumer-smoke.json')
    const markdownPath = path.join(workspace, '.dsh/discussions', 'discussion-consumer-smoke.md')
    const durable = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
    if (durable.revision !== continued.revision || durable.active !== true) {
      throw new Error('sidecar JSON is not the authoritative latest state')
    }
    const markdown = await fs.readFile(markdownPath, 'utf8')
    if (!markdown.includes('Continued after a full DSH restart.')) {
      throw new Error('sidecar Markdown did not record the post-restart continuation')
    }
    console.log('DISCUSSION_CONSUMER_RELOAD_OK')
  } catch (error) {
    console.error('DISCUSSION_CONSUMER_RELOAD_FAILED', error)
  }
}
`

try {
  await mkdir(packDirectory, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(driverPath, driverSource, 'utf8')
  await writeFile(overlayPath, `- insert:\n    - id: discussion-consumer-smoke\n      name: ${JSON.stringify(driverPath)}\n`, 'utf8')
  await writeFile(reloadDriverPath, reloadDriverSource, 'utf8')
  await writeFile(reloadOverlayPath, `- insert:\n    - id: discussion-consumer-reload-smoke\n      name: ${JSON.stringify(reloadDriverPath)}\n`, 'utf8')

  await run('pnpm', ['pack', '--pack-destination', packDirectory])
  const tarballName = (await readdir(packDirectory)).find(name => name.endsWith('.tgz'))
  if (tarballName === undefined) throw new Error('pnpm pack produced no tarball')
  const tarballPath = join(packDirectory, tarballName)
  const env = { ...process.env, DSH_HOME: dshHome }
  await run('pnpm', dshArguments(['plugin', '--profile', 'web', 'add', tarballPath]), { env })

  const dump = await run('pnpm', dshArguments(['--profile', 'web', '--dump-config']), { env })
  if (!dump.includes(`name: '${pluginId}'`)) throw new Error('dump-config omitted the installed plugin')
  if (!dump.includes('defaultIntensity: 2')) throw new Error('dump-config omitted the default intensity')

  const installedPackageRoot = join(dshHome, 'profiles/web/node_modules', pluginId)
  const installedHost = await readFile(join(installedPackageRoot, 'lib/index.js'), 'utf8')
  if (/from ["']\.\/contract-[^"']+["']/u.test(installedHost)) {
    throw new Error('installed host bundle references an unpacked shared chunk')
  }
  const installedClient = await readFile(join(installedPackageRoot, 'lib/client.js'), 'utf8')
  for (const marker of ['discussion-intent-rail', 'Focus', 'You', 'Understanding', 'Next']) {
    if (!installedClient.includes(marker)) throw new Error(`installed client bundle omitted ${marker}`)
  }

  const bootOutput = await bootAndProbe(
    overlayPath,
    'DISCUSSION_CONSUMER_SMOKE_OK',
    undefined,
    async ({ port }) => {
      const base = `http://127.0.0.1:${String(port)}`

      // 1. Client bundle and index manifest are served for the web profile.
      const clientBundle = await httpText(`${base}/plugins/${pluginId}/client.js`)
      if (!clientBundle.includes('discussion-intent-rail')) throw new Error('served client bundle omitted the rail')
      const indexHtml = await httpText(`${base}/`)
      if (!indexHtml.includes(pluginId)) throw new Error('index.html does not reference the plugin client')

      // 2. The state snapshot endpoint answers before and after activation.
      const active = await httpJson(`${base}/dsh/discussion-intent/state?sessionId=${sessionId}`)
      if (active.status !== 200) throw new Error(`state endpoint returned ${String(active.status)}`)
      if (active.value.active !== true || active.value.intensity !== 2 || active.value.revision !== 1) {
        throw new Error(`state endpoint snapshot is wrong: ${JSON.stringify(active.value)}`)
      }

      // 3. SSE: first frame is the current state, second is the delayed
      //    /discussion 1 push (the substantive-change notification contract).
      let frame = 0
      await sseData(`${base}/dsh/discussion-intent/events?sessionId=${sessionId}`, value => {
        frame += 1
        if (frame === 1) {
          if (value.active !== true || value.intensity !== 2) {
            throw new Error(`SSE snapshot is wrong: ${JSON.stringify(value)}`)
          }
          return false
        }
        if (value.active !== true || value.intensity !== 1 || value.revision !== 2) {
          throw new Error(`SSE push is wrong: ${JSON.stringify(value)}`)
        }
        return true
      })

      // 4. An unknown session id gets the inactive shorthand, not an error.
      const unknown = await httpJson(`${base}/dsh/discussion-intent/state?sessionId=no-such-session`)
      if (unknown.status !== 200 || unknown.value.active !== false) {
        throw new Error(`unknown session answered ${JSON.stringify(unknown)}`)
      }
    },
  )
  process.stdout.write(bootOutput)

  const reloadOutput = await bootAndProbe(
    reloadOverlayPath,
    'DISCUSSION_CONSUMER_RELOAD_OK',
    'DISCUSSION_CONSUMER_RELOAD_FAILED',
    async ({ port }) => {
      const base = `http://127.0.0.1:${String(port)}`
      const snapshot = await httpJson(`${base}/dsh/discussion-intent/state?sessionId=${sessionId}`)
      if (snapshot.status !== 200) throw new Error(`reload state endpoint returned ${String(snapshot.status)}`)
      if (snapshot.value.active !== true || snapshot.value.intensity !== 1 || snapshot.value.checkpoint.status !== 'saved') {
        throw new Error(`restored Rail snapshot is wrong: ${JSON.stringify(snapshot.value)}`)
      }
      if (typeof snapshot.value.revision !== 'number' || snapshot.value.revision < 3) {
        throw new Error(`restored Rail revision did not advance: ${JSON.stringify(snapshot.value)}`)
      }
    },
  )
  process.stdout.write(reloadOutput)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
