import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../src/index.ts'
import { discussionMarkdownPath, discussionStateJsonPath } from '../src/sidecar.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface CapturedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: unknown, res: unknown) => void | Promise<void>
}

function fakeWebServer() {
  const routes: CapturedRoute[] = []
  return {
    routes,
    register(route: CapturedRoute) {
      routes.push(route)
      return () => undefined
    },
  }
}

class MockRequest {
  constructor(
    readonly url: string,
    readonly method = 'GET',
    readonly body = '',
  ) {}
  on() { return this }
  async *[Symbol.asyncIterator]() {
    if (this.body !== '') yield Buffer.from(this.body)
  }
}

class MockResponse {
  statusCode = 0
  headers: Record<string, string | number> = {}
  writes: string[] = []
  ended = false
  writeHead(code: number, headers: Record<string, string | number>) {
    this.statusCode = code
    Object.assign(this.headers, headers)
  }
  write(chunk: string | Buffer) { this.writes.push(String(chunk)) }
  end(chunk?: string | Buffer) {
    if (chunk !== undefined) this.writes.push(String(chunk))
    this.ended = true
  }
  on() { return this }
}

function buildAgent(session: ReturnType<SessionStore['create']>): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    steer(message: UserMessage) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as unknown as Agent
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-plugin-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  const webServer = fakeWebServer()
  ctx.provide('webServer', webServer)
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
  }, { inject }))
  const session = ctx.sessions.create(SessionId('discussion-plugin-test'), { meta: { cwd: root } })
  const agent = buildAgent(session)
  return { root, ctx, webServer, session, agent }
}

describe('real DSH host composition', () => {
  it('starts from the bare slash command without inferring a topic, persists sidecar state, and writes Markdown', async () => {
    const { root, ctx, session, agent } = await harness()
    expect(ctx.commands.list(agent).find(command => command.name === 'discussion')?.input?.hint)
      .toBe('[1=fast | 2=default | 3=deep | model [<provider>/<id>] | accept <id> | reject <id> | off]')

    const result = await ctx.commands.execute(agent, '/discussion', new AbortController().signal)
    expect(result?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('2=default'),
    })
    expect(String((result?.result as { text?: string } | undefined)?.text)).toContain('Intensity only')
    expect(String((result?.result as { text?: string } | undefined)?.text)).not.toContain('inferred')
    const state = ctx.discussionIntent.get(agent)
    expect(state).toMatchObject({
      active: true,
      intensity: 2,
      revision: 1,
      provisionalTitle: 'Untitled',
    })
    expect(session.events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)
    // The session log stays untouched: no custom session events.
    expect(session.events.some(event => event.type.startsWith('discussion-intent/'))).toBe(false)
    const policy = (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .find(section => section.name === 'discussion-intent:policy')?.text
    expect(policy).toContain('Discussion Mode is active')
    expect(policy).toContain('native ask_user_question')
    expect(policy).toContain('Stage · settled · open forks')
    expect(policy).toContain('benefit / cost / assumption / consequence')
    expect(policy).toContain('Pending first')
    expect(policy).not.toContain('Ask one question at a time')
    expect(policy).not.toContain('Infer the provisional topic')
    expect(state?.checkpoint.status).toBe('saved')
    const markdownPath = discussionMarkdownPath(root, '.dsh/discussions', 'discussion-plugin-test')
    expect(state?.checkpoint.status === 'saved' && state.checkpoint.filePath).toBe(markdownPath)
    expect(await readFile(markdownPath, 'utf8')).toContain('# Untitled')
    expect(await readFile(markdownPath, 'utf8')).not.toContain('Topic to be distilled')
    const jsonPath = discussionStateJsonPath(root, '.dsh/discussions', 'discussion-plugin-test')
    const durable = JSON.parse(await readFile(jsonPath, 'utf8'))
    expect(durable).toMatchObject({
      active: true,
      intensity: 2,
      revision: 1,
      pendingFrameChanges: [],
      checkpoint: { status: 'saved' },
    })
  })

  it('binds exact direct-user quotes, updates the Markdown before replying, changes intensity, and pauses cleanly', async () => {
    const { ctx, session, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Do not make occlusion the main research topic; it is too rare in practice.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = await ctx.tools.execute({
      callId: CallId('discussion-update-1'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 1,
        provisionalTitle: 'Useful OOD experience from embodied World Models',
        goal: 'Converge on a novel direction with measurable downstream data value.',
        captures: [{
          kind: 'rejection',
          quote: 'Do not make occlusion the main research topic; it is too rare in practice.',
          eventSeq: user.seq,
          normalizedRestatement: 'Occlusion is an optional stress test, not the thesis.',
        }],
        focus: {
          currentQuestion: 'Which OOD experience is valuable, scarce, and verifiable?',
          level: 'direction',
        },
        synthesis: {
          interpretation: 'The direction must target broad data utility rather than a narrow demo case.',
          recommendation: 'Compare action-outcome reliability gaps on strong open bases.',
          openPoint: 'Which task family provides paired truth?',
          nextStep: 'Audit paired-truth feasibility.',
        },
        historySummary: 'Removed occlusion from the thesis and re-anchored on OOD data utility.',
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(false)
    const updated = ctx.discussionIntent.get(agent)
    expect(updated?.humanFrame[0]?.statement).toBe('Do not make occlusion the main research topic; it is too rare in practice.')
    expect(updated?.provisionalTitle).toBe('Untitled')
    expect(updated?.focus.currentQuestion).toBe('Do not make occlusion the main research topic; it is too rare in practice.')
    expect(updated?.rootFocus.currentQuestion).toBe('No topic yet.')
    expect(updated?.pendingFrameChanges.map(change => change.target)).toEqual(expect.arrayContaining(['title', 'goal', 'root-focus']))
    if (updated?.checkpoint.status !== 'saved') throw new Error('expected saved checkpoint')
    const markdown = await readFile(updated.checkpoint.filePath, 'utf8')
    expect(markdown).toContain('Occlusion is an optional stress test, not the thesis.')
    expect(markdown).toContain('Audit paired-truth feasibility.')
    expect(markdown).toContain('## Pending Frame Changes')

    await ctx.commands.execute(agent, '/discussion 1', new AbortController().signal)
    expect(ctx.discussionIntent.get(agent)).toMatchObject({ active: true, intensity: 1, revision: 3 })
    await ctx.commands.execute(agent, '/discussion off', new AbortController().signal)
    expect(ctx.discussionIntent.get(agent)).toMatchObject({ active: false, intensity: 1, revision: 4 })
    const policy = (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .find(section => section.name === 'discussion-intent:policy')?.text
    expect(policy).toBe('')
    expect(session.events.some(event => event.type.startsWith('discussion-intent/'))).toBe(false)
  })

  it('rejects model-authored text that cannot be found in a direct same-session user message', async () => {
    const { ctx, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion', new AbortController().signal)
    const result = await ctx.tools.execute({
      callId: CallId('discussion-update-forged'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 1,
        captures: [{ kind: 'decision', quote: 'The user chose the occlusion direction.' }],
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('No same-session direct user message'))).toBe(true)
  })
})

describe('durability across a full host restart', () => {
  it('restores the sidecar state into a fresh host and continues the update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-restart-'))
    temporaryRoots.push(root)
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SystemPrompt)
    await first.plugin(ToolRuntime)
    await first.plugin(CommandRuntime)
    await first.plugin(Object.assign((inner: Context) => {
      apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
    }, { inject }))
    const firstSession = first.sessions.create(SessionId('discussion-restart-test'), { meta: { cwd: root } })
    const firstAgent = buildAgent(firstSession)
    await first.commands.execute(firstAgent, '/discussion 3', new AbortController().signal)
    const updated = await first.discussionIntent.update(firstAgent, {
      expectedRevision: 1,
      provisionalTitle: 'Pre-restart title',
      historySummary: 'Work before the restart.',
    })
    expect(updated.checkpoint.status).toBe('saved')
    expect(updated.provisionalTitle).toBe('Untitled')
    expect(updated.pendingFrameChanges).toMatchObject([{
      status: 'pending',
      target: 'title',
      proposed: 'Pre-restart title',
    }])

    // Simulate a complete DSH exit and a new process reopening the same session.
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await second.plugin(CommandRuntime)
    await second.plugin(Object.assign((inner: Context) => {
      apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
    }, { inject }))
    const secondSession = second.sessions.create(SessionId('discussion-restart-test'), { meta: { cwd: root } })
    const secondAgent = buildAgent(secondSession)
    const restored = second.discussionIntent.get(secondAgent)
    expect(restored).toMatchObject({
      active: true,
      intensity: 3,
      revision: 2,
      provisionalTitle: 'Untitled',
      checkpoint: { status: 'saved' },
    })
    expect(restored?.pendingFrameChanges).toMatchObject([{
      status: 'pending',
      target: 'title',
      proposed: 'Pre-restart title',
    }])
    const policy = (await second.systemPrompt.assemble({ agent: secondAgent, scope: secondAgent })).sections
      .find(section => section.name === 'discussion-intent:policy')?.text
    expect(policy).toContain('Pre-restart title')
    expect(policy).toContain('Pending Frame Changes')
    const continued = await second.discussionIntent.update(secondAgent, {
      expectedRevision: restored!.revision,
      historySummary: 'Continued after the restart.',
    })
    expect(continued).toMatchObject({ revision: 3, checkpoint: { status: 'saved' } })
    expect(continued.provisionalTitle).toBe('Untitled')
    const durable = JSON.parse(await readFile(discussionStateJsonPath(root, '.dsh/discussions', 'discussion-restart-test'), 'utf8'))
    expect(durable.revision).toBe(3)
    expect(await readFile(discussionMarkdownPath(root, '.dsh/discussions', 'discussion-restart-test'), 'utf8'))
      .toContain('Continued after the restart')
  })
})

describe('Web Rail transport (optional webServer service)', () => {
  it('serves the state snapshot and pushes each substantive change over SSE', async () => {
    const { ctx, webServer, agent } = await harness()
    expect(webServer.routes).toHaveLength(1)
    const route = webServer.routes[0]!
    expect(route).toMatchObject({ kind: 'prefix', path: '/dsh/discussion-intent' })

    // No state yet: the state endpoint answers with the active:false shorthand.
    const empty = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/state?sessionId=discussion-plugin-test'), empty)
    await new Promise(resolve => setImmediate(resolve))
    expect(empty.statusCode).toBe(200)
    expect(JSON.parse(empty.writes.join(''))).toEqual({ active: false })

    await ctx.commands.execute(agent, '/discussion 2', new AbortController().signal)

    const snapshot = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/state?sessionId=discussion-plugin-test'), snapshot)
    await new Promise(resolve => setImmediate(resolve))
    expect(snapshot.statusCode).toBe(200)
    expect(JSON.parse(snapshot.writes.join(''))).toMatchObject({
      active: true,
      intensity: 2,
      revision: 1,
      subagent: { model: 'unset', effort: 'default', phase: 'next' },
    })

    // Open an SSE stream, receive the current state, then receive the push.
    const stream = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/events?sessionId=discussion-plugin-test'), stream)
    await new Promise(resolve => setImmediate(resolve))
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(stream.writes.join('')).toContain('"intensity":2')

    await ctx.commands.execute(agent, '/discussion 1', new AbortController().signal)
    expect(stream.writes.join('')).toContain('"intensity":1')

    // Unknown session ids get the inactive shorthand, never an error stream.
    const unknown = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/state?sessionId=nope'), unknown)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(JSON.parse(unknown.writes.join(''))).toEqual({ active: false })
  })

  it('emits the current snapshot when /discussion repeats the same intensity', async () => {
    const { ctx, webServer, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const route = webServer.routes[0]!
    const stream = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/events?sessionId=discussion-plugin-test'), stream)
    await new Promise(resolve => setImmediate(resolve))
    const before = stream.writes.length
    const revision = ctx.discussionIntent.get(agent)!.revision
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    expect(ctx.discussionIntent.get(agent)?.revision).toBe(revision)
    expect(stream.writes.length).toBeGreaterThan(before)
    expect(stream.writes.join('')).toContain('"active":true')
    expect(stream.writes.join('')).toContain('"intensity":3')
  })

  it('attaches the configured spawn model and default effort to the Rail snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-subagent-rail-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    const webServer = fakeWebServer()
    ctx.provide('webServer', webServer)
    ctx.provide('settings', {
      register() {
        return {
          get: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
          replace: async () => undefined,
        }
      },
    })
    ctx.provide('llm', {
      listProviders: () => [],
      listModels: async () => [],
      resolveCallConfig: async () => ({ reasoningEffort: 'high' }),
    })
    await ctx.plugin(Object.assign((inner: Context) => {
      apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
    }, { inject }))
    const session = ctx.sessions.create(SessionId('discussion-subagent-rail'), { meta: { cwd: root } })
    const agent = buildAgent(session)
    await ctx.commands.execute(agent, '/discussion 2', new AbortController().signal)
    const route = webServer.routes[0]!
    let body: { subagent?: { model?: string; effort?: string; phase?: string; provider?: string } } = {}
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snapshot = new MockResponse()
      await route.handler(new MockRequest('/dsh/discussion-intent/state?sessionId=discussion-subagent-rail'), snapshot)
      await new Promise(resolve => setImmediate(resolve))
      body = JSON.parse(snapshot.writes.join('')) as typeof body
      if (body.subagent?.effort === 'high') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(body).toMatchObject({
      active: true,
      subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high', phase: 'next' },
    })
  })

  it('does not push active:false over SSE while sessions.get is not ready', async () => {
    const { webServer } = await harness()
    const route = webServer.routes[0]!
    const stream = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/events?sessionId=not-ready-yet'), stream)
    await new Promise(resolve => setTimeout(resolve, 120))
    const body = stream.writes.join('')
    expect(body).toContain(': waiting')
    expect(body).not.toContain('data: {"active":false}')
  })
})

const FLASH = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const

async function modelHarness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-model-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  const webServer = fakeWebServer()
  ctx.provide('webServer', webServer)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    async listModels(provider: string) {
      return [
        { provider, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ]
    },
  })
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
  }, { inject }))
  const session = ctx.sessions.create(SessionId('discussion-model-test'), { meta: { cwd: root } })
  const agent = buildAgent(session)
  return { ctx, webServer, session, agent }
}

async function snapshotSubagent(route: CapturedRoute, sessionId: string) {
  const snapshot = new MockResponse()
  await route.handler(new MockRequest(`/dsh/discussion-intent/state?sessionId=${sessionId}`), snapshot)
  await new Promise(resolve => setImmediate(resolve))
  return JSON.parse(snapshot.writes.join('')) as {
    readonly active?: boolean
    readonly intensity?: number
    readonly revision?: number
    readonly subagent?: { readonly model?: string; readonly provider?: string; readonly phase?: string }
  }
}

describe('subagent model slash and HTTP', () => {
  it('lists the catalog from /discussion model without a model turn or intensity change', async () => {
    const { ctx, webServer, session, agent } = await modelHarness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const before = ctx.discussionIntent.get(agent)
    const listed = await ctx.commands.execute(agent, '/discussion model', new AbortController().signal)
    expect(listed?.result).toMatchObject({ kind: 'success' })
    const text = String((listed?.result as { text?: string } | undefined)?.text)
    expect(text).toContain('unset')
    expect(text).toContain('deepseek-official/deepseek-v4-flash')
    expect(text).toContain('deepseek-official/deepseek-v4-pro')
    expect(ctx.discussionIntent.get(agent)?.intensity).toBe(3)
    expect(ctx.discussionIntent.get(agent)?.revision).toBe(before?.revision)
    expect(session.events.some(event => event.type.startsWith('discussion-intent/'))).toBe(false)
    const route = webServer.routes[0]!
    expect((await snapshotSubagent(route, 'discussion-model-test')).subagent?.model).toBe('unset')
  })

  it('does not pick a model on /discussion or /discussion 3', async () => {
    const { ctx, webServer, agent } = await modelHarness()
    await ctx.commands.execute(agent, '/discussion', new AbortController().signal)
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const route = webServer.routes[0]!
    expect((await snapshotSubagent(route, 'discussion-model-test')).subagent).toMatchObject({
      model: 'unset',
      phase: 'next',
    })
  })

  it('persists /discussion model <provider>/<id> so the chip is no longer unset', async () => {
    const { ctx, webServer, session, agent } = await modelHarness()
    await ctx.commands.execute(agent, '/discussion', new AbortController().signal)
    const set = await ctx.commands.execute(
      agent,
      '/discussion model deepseek-official/deepseek-v4-flash',
      new AbortController().signal,
    )
    expect(set?.result).toMatchObject({ kind: 'success' })
    expect(String((set?.result as { text?: string } | undefined)?.text)).toContain('deepseek-official/deepseek-v4-flash')
    expect(session.events.some(event => event.type.startsWith('discussion-intent/'))).toBe(false)
    const route = webServer.routes[0]!
    expect(await snapshotSubagent(route, 'discussion-model-test')).toMatchObject({
      active: true,
      subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', phase: 'next' },
    })
  })

  it('serves the catalog and persists a chip POST that refreshes the overlay', async () => {
    const { ctx, webServer, session, agent } = await modelHarness()
    await ctx.commands.execute(agent, '/discussion 2', new AbortController().signal)
    const route = webServer.routes[0]!

    const catalog = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/models'), catalog)
    await new Promise(resolve => setImmediate(resolve))
    expect(JSON.parse(catalog.writes.join(''))).toMatchObject({
      models: [
        { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    })

    const stream = new MockResponse()
    await route.handler(new MockRequest('/dsh/discussion-intent/events?sessionId=discussion-model-test'), stream)
    await new Promise(resolve => setImmediate(resolve))
    expect(stream.writes.join('')).toContain('"model":"unset"')

    const post = new MockResponse()
    await route.handler(
      new MockRequest('/dsh/discussion-intent/subagent', 'POST', JSON.stringify(FLASH)),
      post,
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(JSON.parse(post.writes.join(''))).toEqual({ ok: true, ...FLASH })
    expect(stream.writes.join('')).toContain('"model":"deepseek-v4-flash"')
    expect(await snapshotSubagent(route, 'discussion-model-test')).toMatchObject({
      active: true,
      subagent: { provider: FLASH.provider, model: FLASH.model, phase: 'next' },
    })
    expect(session.events.some(event => event.type.startsWith('discussion-intent/'))).toBe(false)
  })
})
