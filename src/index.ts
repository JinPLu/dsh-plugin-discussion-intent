import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  activateDiscussion,
  applyDiscussionUpdate,
  deactivateDiscussion,
  intensityName,
  parseIntensity,
  renderDiscussionPolicy,
  withCheckpoint,
  type CaptureRequest,
  type DiscussionFocus,
  type DiscussionIntensity,
  type DiscussionOptionUpdate,
  type DiscussionState,
  type DiscussionSynthesis,
  type DiscussionUpdate,
  type ResolvedCapture,
} from './contract.ts'
import {
  DEFAULT_DIRECTORY,
  discussionSidecarRevisionSync,
  discussionStateJsonPath,
  readDiscussionSidecarSync,
  writeDiscussionSidecar,
} from './sidecar.ts'

export const name = 'discussion-intent'
export const inject = ['commands', 'sessions', 'systemPrompt', 'tools']

export interface Config {
  readonly enabled: boolean
  readonly defaultIntensity: DiscussionIntensity
  /** Workspace-relative checkpoint directory. */
  readonly directory: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  defaultIntensity: z.number().default(2),
  directory: z.string().default(DEFAULT_DIRECTORY),
}) as unknown as z<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    discussionIntent: DiscussionIntentController
  }

  interface Events {
    /** Plugin-internal push after every substantive Discussion state change (in-process only, never a session event). */
    'discussion-intent/change'(sessionId: string, state: DiscussionState): void
  }
}

const USAGE = '/discussion [1=fast | 2=default | 3=deep] or /discussion off'
const HUMAN_FRAME_KINDS = ['goal', 'constraint', 'criterion', 'preference', 'decision', 'rejection', 'non-goal'] as const
const FOCUS_LEVELS = ['project', 'direction', 'mechanism', 'experiment', 'decision'] as const
const OPTION_STATUSES = ['open', 'favored', 'rejected'] as const

interface ToolInput {
  readonly expectedRevision: number
  readonly provisionalTitle?: string
  readonly goal?: string
  readonly captures?: readonly CaptureRequest[]
  readonly supersedeStatementIds?: readonly string[]
  readonly focus?: DiscussionFocus
  readonly optionUpdates?: readonly DiscussionOptionUpdate[]
  readonly synthesis?: Partial<DiscussionSynthesis>
  readonly historySummary?: string
}

interface ToolValue {
  readonly revision: number
  readonly intensity: number
  readonly title: string
  readonly saveStatus: 'saved' | 'error'
  readonly filePath?: string
  readonly message?: string
}

function normalizeConfig(config: Config): Config {
  const intensity = parseIntensity(String(config.defaultIntensity))
  if (intensity === undefined) throw new Error('defaultIntensity must be 1, 2, or 3.')
  const directory = config.directory.trim()
  if (directory === '') throw new Error('directory must not be empty.')
  return { enabled: config.enabled, defaultIntensity: intensity, directory }
}

function directUserText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const text = event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

function resolveCapture(agent: Agent, capture: CaptureRequest): ResolvedCapture {
  const quote = capture.quote.trim()
  if (quote === '') throw new Error('capture quote must not be empty.')
  const candidate = capture.eventSeq === undefined
    ? [...agent.session.events].reverse().find(event => directUserText(event)?.includes(quote))
    : agent.session.events.find(event => event.seq === capture.eventSeq)
  const sourceText = candidate === undefined ? undefined : directUserText(candidate)
  if (candidate === undefined || sourceText === undefined || !sourceText.includes(quote)) {
    throw new Error(`No same-session direct user message contains the exact quote ${JSON.stringify(quote)}.`)
  }
  return {
    kind: capture.kind,
    quote,
    eventSeq: candidate.seq,
    ...(capture.normalizedRestatement === undefined ? {} : { normalizedRestatement: capture.normalizedRestatement }),
  }
}

/**
 * Runtime controller kept public for focused integration tests and read-only
 * adapters. All state lives in the plugin's own sidecar
 * (`<workspace>/.dsh/discussions/<sessionId>.json|.md`), loaded on demand by
 * every consumer, with an in-process memory fallback for sessions that have no
 * workspace path or whose write failed.
 */
export class DiscussionIntentController extends Service {
  private readonly memory = new Map<string, DiscussionState>()
  private readonly sidecarCache = new Map<string, { readonly mtimeMs: number | undefined; readonly state: DiscussionState | undefined }>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'discussionIntent')
  }

  /** Workspace-relative checkpoint directory this controller persists into. */
  get directory(): string {
    return this.config.directory
  }

  get(agent: Agent): DiscussionState | undefined {
    return this.load(agent.session)
  }

  load(session: Session): DiscussionState | undefined {
    const cwd = session.header.cwd
    if (cwd === undefined) return this.memory.get(session.id)
    const cacheKey = discussionStateJsonPath(cwd, this.config.directory, session.id)
    const mtimeMs = discussionSidecarRevisionSync(cwd, this.config.directory, session.id)
    const cached = this.sidecarCache.get(cacheKey)
    let state: DiscussionState | undefined
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      state = cached.state
    } else {
      state = mtimeMs === undefined ? undefined : readDiscussionSidecarSync(cwd, this.config.directory, session.id)
      this.sidecarCache.set(cacheKey, { mtimeMs, state })
    }
    const inMemory = this.memory.get(session.id)
    if (inMemory !== undefined && (state === undefined || inMemory.revision > state.revision)) return inMemory
    return state
  }

  async activate(agent: Agent, intensity: DiscussionIntensity): Promise<DiscussionState> {
    const current = this.get(agent)
    const next = activateDiscussion(current, {
      id: current?.id ?? `discussion-${randomUUID()}`,
      intensity,
      now: Date.now(),
    })
    return next === current ? next : this.commit(agent, next)
  }

  async deactivate(agent: Agent): Promise<DiscussionState | undefined> {
    const current = this.get(agent)
    if (current === undefined || !current.active) return current
    return this.commit(agent, deactivateDiscussion(current, Date.now()))
  }

  async update(agent: Agent, input: ToolInput): Promise<DiscussionState> {
    const current = this.get(agent)
    if (current === undefined) throw new Error('No Discussion state exists. Use /discussion first.')
    const captures = input.captures?.map(capture => resolveCapture(agent, capture))
    const update: DiscussionUpdate = {
      expectedRevision: input.expectedRevision,
      ...(input.provisionalTitle === undefined ? {} : { provisionalTitle: input.provisionalTitle }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(captures === undefined ? {} : { captures }),
      ...(input.supersedeStatementIds === undefined ? {} : { supersedeStatementIds: input.supersedeStatementIds }),
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(input.optionUpdates === undefined ? {} : { optionUpdates: input.optionUpdates }),
      ...(input.synthesis === undefined ? {} : { synthesis: input.synthesis }),
      ...(input.historySummary === undefined ? {} : { historySummary: input.historySummary }),
    }
    return this.commit(agent, applyDiscussionUpdate(current, update, Date.now()))
  }

  private async commit(agent: Agent, state: DiscussionState): Promise<DiscussionState> {
    const session = agent.session
    const cwd = session.header.cwd
    const checkpointed = cwd === undefined
      ? withCheckpoint(state, {
        status: 'error',
        message: 'This session has no workspace path; Discussion state was not written to disk.',
      })
      : await writeDiscussionSidecar(cwd, this.config.directory, session.id, state)
    if (cwd !== undefined && checkpointed.checkpoint.status === 'saved') {
      const cacheKey = discussionStateJsonPath(cwd, this.config.directory, session.id)
      this.sidecarCache.set(cacheKey, {
        mtimeMs: discussionSidecarRevisionSync(cwd, this.config.directory, session.id),
        state: checkpointed,
      })
    }
    this.memory.set(session.id, checkpointed)
    this.ctx.emit('discussion-intent/change', session.id, checkpointed)
    return checkpointed
  }
}

function wakeDiscussion(agent: Agent, state: DiscussionState): void {
  const text = [
    `Discussion Mode is active at ${String(state.intensity)}=${intensityName(state.intensity)}.`,
    'Infer the provisional topic and goal from the conversation so far.',
    'Use discussion_update before the substantive reply so the discussion checkpoint is current.',
    'If a material preference or boundary is genuinely ambiguous, ask one question with the native ask_user_question tool; otherwise begin the discussion directly.',
  ].join(' ')
  agent.steer(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'discussion-intent', form: 'notice', summary: 'Discussion Mode activated' },
  }))
}

function checkpointSuffix(state: DiscussionState): string {
  if (state.checkpoint.status === 'saved') return `Saved: ${state.checkpoint.filePath}`
  if (state.checkpoint.status === 'error') return `Markdown not saved: ${state.checkpoint.message}`
  return 'Markdown checkpoint pending.'
}

function registerTool(ctx: Context, controller: DiscussionIntentController): void {
  ctx.tools.register(defineTool({
    name: 'discussion_update',
    description: 'Update the active Discussion state before a substantive discussion reply. Preserve user constraints, current focus, rejected directions, evidence, synthesis, and next step. Direct-user captures must quote an exact same-session user message.',
    parameters: {
      expectedRevision: { type: 'integer', required: true, description: 'Current Discussion revision shown in the system policy.' },
      provisionalTitle: { type: 'string', description: 'Short model-owned working title inferred from the conversation.' },
      goal: { type: 'string', description: 'The outcome this discussion should converge toward.' },
      captures: {
        type: 'array',
        description: 'Exact excerpts from direct user messages. Omit eventSeq to bind the latest matching direct-user message.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: HUMAN_FRAME_KINDS },
            quote: { type: 'string', required: true },
            eventSeq: { type: 'integer' },
            normalizedRestatement: { type: 'string', description: 'Optional model wording, kept separate from the quote.' },
          },
        },
      },
      supersedeStatementIds: { type: 'array', items: { type: 'string' }, description: 'Earlier statement ids made obsolete by later direct user evidence.' },
      focus: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currentQuestion: { type: 'string', required: true },
          level: { type: 'string', required: true, enum: FOCUS_LEVELS },
          returnTo: { type: 'string', description: 'Higher-level question to return to after this sub-question.' },
        },
      },
      optionUpdates: {
        type: 'array',
        description: 'Incremental upserts for meaningful alternatives and their evidence.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string' },
            evidenceFor: { type: 'array', items: { type: 'string' } },
            evidenceAgainst: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: OPTION_STATUSES },
          },
        },
      },
      synthesis: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interpretation: { type: 'string' },
          recommendation: { type: 'string' },
          openPoint: { type: 'string' },
          nextStep: { type: 'string' },
        },
      },
      historySummary: { type: 'string', description: 'One concise durable note for a material turn, decision, correction, or rejected direction.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revision: { type: 'integer', required: true },
          intensity: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          saveStatus: { type: 'string', required: true, enum: ['saved', 'error'] },
          filePath: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value: ToolValue) => [{
        type: 'text',
        text: value.saveStatus === 'saved'
          ? `Discussion updated to revision ${String(value.revision)} and saved to ${value.filePath ?? 'the workspace checkpoint'}.`
          : `Discussion updated to revision ${String(value.revision)}, but Markdown was not saved: ${value.message ?? 'unknown error'}.`,
      }],
    },
    execute: async (args, exec): Promise<ToolValue> => {
      if (exec.agent === undefined) throw new Error('discussion_update requires an owning agent session.')
      const state = await controller.update(exec.agent, args as unknown as ToolInput)
      return {
        revision: state.revision,
        intensity: state.intensity,
        title: state.provisionalTitle,
        saveStatus: state.checkpoint.status === 'saved' ? 'saved' : 'error',
        ...(state.checkpoint.status === 'saved' ? { filePath: state.checkpoint.filePath } : {}),
        ...(state.checkpoint.status === 'error' ? { message: state.checkpoint.message, ...(state.checkpoint.filePath === undefined ? {} : { filePath: state.checkpoint.filePath }) } : {}),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Update discussion', kind: 'other' }),
  }))
}

/**
 * The Web Rail transport. The public rc.6 `webServer` service (present in the
 * web profile) serves the plugin-owned state and an SSE push stream under a
 * plugin-owned prefix. Without `webServer` (headless/TUI profiles) the plugin
 * simply skips this channel — the host features are unaffected.
 */
type RailSnapshot = { readonly active: false } | DiscussionState

interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function railSnapshot(state: DiscussionState | undefined): RailSnapshot {
  return state ?? { active: false }
}

function registerRailTransport(ctx: Context, controller: DiscussionIntentController): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined
  const streams = new Map<string, Set<ServerResponse>>()

  function resolve(sessionId: string): Promise<DiscussionState | undefined> {
    if (sessionId === '') return Promise.resolve(undefined)
    const session = ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) return Promise.resolve(undefined)
    return Promise.resolve(controller.load(session))
  }

  function push(sessionId: string, state: DiscussionState): void {
    const listeners = streams.get(sessionId)
    if (listeners === undefined) return
    const payload = `${JSON.stringify(state)}\n`
    for (const response of listeners) response.write(`data: ${payload}\n\n`)
  }

  const offChange = ctx.on('discussion-intent/change', (sessionId, state) => { push(sessionId, state) })

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://discussion-intent.invalid')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (url.pathname === '/dsh/discussion-intent/state') {
      void resolve(sessionId).then(state => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`${JSON.stringify(railSnapshot(state))}\n`)
      }, error => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(`${JSON.stringify({ active: false, error: error instanceof Error ? error.message : String(error) })}\n`)
      })
      return
    }
    if (url.pathname === '/dsh/discussion-intent/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      let closed = false
      const listeners = streams.get(sessionId) ?? new Set<ServerResponse>()
      streams.set(sessionId, listeners)
      listeners.add(res)
      void resolve(sessionId).then(state => {
        if (!closed) res.write(`data: ${JSON.stringify(railSnapshot(state))}\n\n`)
      })
      const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n') }, 15_000)
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        listeners.delete(res)
        if (listeners.size === 0) streams.delete(sessionId)
        res.end()
      }
      res.on('close', close)
      req.on('close', close)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{"error":"not found"}\n')
  }

  const dispose = webServer.register({ kind: 'prefix', path: '/dsh/discussion-intent', handler })
  return () => {
    dispose()
    offChange()
    for (const listeners of streams.values()) {
      for (const response of listeners) response.end()
    }
    streams.clear()
  }
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const controller = new DiscussionIntentController(ctx, config)

  ctx.systemPrompt.section({
    name: 'discussion-intent:policy',
    order: 49,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const state = controller.get(agent)
      return state?.active === true ? renderDiscussionPolicy(state) : ''
    },
  })

  ctx.commands.register({
    name: 'discussion',
    description: 'start, tune, resume, or leave Discussion Mode',
    input: { hint: '[1=fast | 2=default | 3=deep | off]' },
    handler: async ({ agent, rawInput }) => {
      const input = rawInput.trim()
      if (input === 'off') {
        const state = await controller.deactivate(agent)
        if (state === undefined || state.active) return { kind: 'success', text: 'Discussion Mode is not active.' }
        return { kind: 'success', text: `Discussion Mode paused. ${checkpointSuffix(state)}` }
      }
      const current = controller.get(agent)
      const intensity = input === '' ? current?.intensity ?? config.defaultIntensity : parseIntensity(input)
      if (intensity === undefined) return { kind: 'error', text: `Usage: ${USAGE}` }
      const state = await controller.activate(agent, intensity)
      wakeDiscussion(agent, state)
      return {
        kind: 'success',
        text: `Discussion Mode: ${String(state.intensity)}=${intensityName(state.intensity)}. The topic will be inferred from context. Use /discussion off to leave. ${checkpointSuffix(state)}`,
      }
    },
  })

  registerTool(ctx, controller)

  ctx.inject(['webServer'], railCtx => {
    railCtx.effect(
      () => registerRailTransport(railCtx, controller),
      'discussion-intent:rail-transport',
    )
  })
}
