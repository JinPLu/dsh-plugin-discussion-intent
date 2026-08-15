import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dshRepository = process.env.DSH_SMOKE_DSH_REPO
const dshVersion = process.env.DSH_SMOKE_DSH_VERSION || '0.1.0-rc.6'
const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-ui-'))
const packDirectory = join(root, 'pack')
const dshHome = join(root, 'home')
const workspace = join(root, 'workspace')
const driverPath = join(root, 'ui-driver.mjs')
const patchPath = join(root, 'ui-driver.patch.yml')
const port = process.env.DSH_SMOKE_PORT || '63590'

function dshArguments(args) {
  return dshRepository
    ? ['--dir', dshRepository, 'dsh', ...args]
    : ['dlx', `@deepseek-ai/dsh@${dshVersion}`, ...args]
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve(output)
      : reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}\n${output}`)))
  })
}

const driver = `
export const name = 'discussion-ui-smoke'
export const inject = ['agents', 'commands', 'discussionIntent', 'sessions', 'workspaceRegistry']

export async function apply(ctx) {
  const cwd = process.env.DISCUSSION_SMOKE_WORKSPACE
  await ctx.workspaceRegistry.create(cwd)
  const session = ctx.sessions.create('discussion-ui-smoke', { meta: { cwd } })
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    inbox: { hasPending: false },
    options: {},
    ctx,
    steer(message) { session.append('user/message', message, { surfaceOp: 'append' }) },
  }
  ctx.effect(() => ctx.agents.register(agent))
  console.log('DISCUSSION_UI_DEFAULT_READY')
}
`

await mkdir(packDirectory, { recursive: true })
await mkdir(dshHome, { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(driverPath, driver, 'utf8')
await writeFile(patchPath, `- insert:\n    - id: discussion-ui-smoke\n      name: ${JSON.stringify(driverPath)}\n`, 'utf8')

await run('pnpm', ['pack', '--pack-destination', packDirectory])
const tarball = (await readdir(packDirectory)).find(name => name.endsWith('.tgz'))
if (!tarball) throw new Error('pnpm pack produced no tarball')
const env = { ...process.env, DSH_HOME: dshHome, DISCUSSION_SMOKE_WORKSPACE: workspace }
await run('pnpm', dshArguments(['plugin', '--profile', 'web', 'add', join(packDirectory, tarball)]), { env })

const child = spawn('pnpm', dshArguments([
  '--profile', 'web', '--patch', patchPath, '--port', port,
]), { cwd: packageRoot, env, stdio: 'inherit' })

console.log(`DISCUSSION_UI_ROOT=${root}`)
console.log(`DISCUSSION_UI_URL=http://127.0.0.1:${port}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.once('exit', code => { process.exitCode = code ?? 1 })
