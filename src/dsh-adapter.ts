/**
 * DSH host adapter: the single named boundary where this plugin imports DSH
 * host packages and wires host services (slash command, model tool,
 * system-prompt section, Web Rail transport, optional subagents wrap,
 * session read). The public package entry (`index.ts`) is a thin facade over
 * this module. Domain logic stays DSH-independent in `contract.ts`,
 * `sidecar.ts`, and `capabilities.ts`.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  acceptPendingFrameChange,
  activateDiscussion,
  activePendingFrameChanges,
  applyDiscussionUpdate,
  deactivateDiscussion,
  intensityName,
  parseIntensity,
  rejectPendingFrameChange,
  renderDiscussionPolicy,
  UNTITLED_TITLE,
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

const USAGE = '/discussion [1=fast | 2=default | 3=deep] or /discussion accept <id> or /discussion reject <id> or /discussion off'
const COMMAND_HINT = '[1=fast | 2=default | 3=deep | accept <id> | reject <id> | off]'
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
  readonly pendingChangeIds: string[]
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

  async accept(agent: Agent, id: string): Promise<DiscussionState> {
    const current = this.get(agent)
    if (current === undefined) throw new Error('No Discussion state exists. Use /discussion first.')
    return this.commit(agent, acceptPendingFrameChange(current, id, Date.now()))
  }

  async reject(agent: Agent, id: string): Promise<DiscussionState> {
    const current = this.get(agent)
    if (current === undefined) throw new Error('No Discussion state exists. Use /discussion first.')
    return this.commit(agent, rejectPendingFrameChange(current, id, Date.now()))
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

function checkpointSuffix(state: DiscussionState): string {
  if (state.checkpoint.status === 'saved') return `Saved: ${state.checkpoint.filePath}`
  if (state.checkpoint.status === 'error') return `Markdown not saved: ${state.checkpoint.message}`
  return 'Markdown checkpoint pending.'
}

function registerTool(ctx: Context, controller: DiscussionIntentController): void {
  ctx.tools.register(defineTool({
    name: 'discussion_update',
    description: 'Update the active Discussion state before a substantive discussion reply. Capture quoted user statements, add candidate options or evidence, and revise the provisional interpretation. Title, goal, and root-focus writes become Pending Frame Changes; they do not apply until /discussion accept <id>. Direct-user captures must quote an exact same-session user message. supersedeStatementIds requires a new same-session proving quote in the same call.',
    parameters: {
      expectedRevision: { type: 'integer', required: true, description: 'Current Discussion revision shown in the system policy.' },
      provisionalTitle: { type: 'string', description: 'Proposed working title. Becomes a Pending Frame Change; it does not replace the current title.' },
      goal: { type: 'string', description: 'Proposed outcome. Becomes a Pending Frame Change; it does not replace the current goal.' },
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
      supersedeStatementIds: { type: 'array', items: { type: 'string' }, description: 'Earlier statement ids made obsolete by a new same-session proving quote in this call.' },
      focus: {
        type: 'object',
        description: 'Proposed root focus. Becomes a Pending Frame Change; it does not overwrite the locked question.',
        additionalProperties: false,
        properties: {
          currentQuestion: { type: 'string', required: true },
          level: { type: 'string', required: true, enum: FOCUS_LEVELS },
          returnTo: { type: 'string', description: 'Higher-level question to return to after this sub-question.' },
        },
      },
      optionUpdates: {
        type: 'array',
        description: 'Incremental upserts for candidate alternatives and their evidence. Candidates stay candidates; promoting one to the root question is a pending change.',
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
          pendingChangeIds: { type: 'array', required: true, items: { type: 'string' } },
          filePath: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value: ToolValue) => [{
        type: 'text',
        text: [
          value.saveStatus === 'saved'
            ? `Discussion updated to revision ${String(value.revision)} and saved to ${value.filePath ?? 'the workspace checkpoint'}.`
            : `Discussion updated to revision ${String(value.revision)}, but Markdown was not saved: ${value.message ?? 'unknown error'}.`,
          value.pendingChangeIds.length === 0
            ? ''
            : ` Pending Frame Changes: ${value.pendingChangeIds.join(', ')}. Use /discussion accept <id> or /discussion reject <id>.`,
        ].join(''),
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
        pendingChangeIds: activePendingFrameChanges(state).map(change => change.id),
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

const DEFAULT_CHILD_AGENT_OPTIONS = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
} as const

interface ChildAgentOptionsLike {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

interface SubagentStartRequestLike {
  readonly agentOptions?: ChildAgentOptionsLike
}

interface ContinuableStartSpecLike {
  readonly request: SubagentStartRequestLike
}

interface SubagentsLike {
  start: (provider: string, request: SubagentStartRequestLike) => unknown
  startContinuable: (spec: ContinuableStartSpecLike) => unknown
}

function withDefaultChildAgentOptions<T extends SubagentStartRequestLike>(request: T): T {
  return {
    ...request,
    agentOptions: {
      ...DEFAULT_CHILD_AGENT_OPTIONS,
      ...request.agentOptions,
    },
  }
}

/**
 * Live pin for web and other profiles that remount subagent tools inside
 * agent presets. Host-plane `cordis.patch.yml` rows stay as defense-in-depth.
 */
function wrapSubagents(ctx: Context): () => void {
  const subagents = ctx.get('subagents') as SubagentsLike | undefined
  if (subagents === undefined) return () => undefined
  const start = subagents.start.bind(subagents)
  const startContinuable = subagents.startContinuable.bind(subagents)
  subagents.start = (provider, request) => start(provider, withDefaultChildAgentOptions(request))
  subagents.startContinuable = spec => startContinuable({
    ...spec,
    request: withDefaultChildAgentOptions(spec.request),
  })
  return () => {
    subagents.start = start
    subagents.startContinuable = startContinuable
  }
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
    description: 'start, tune, resume, accept or reject a pending change, or leave Discussion Mode',
    input: { hint: COMMAND_HINT },
    handler: async ({ agent, rawInput }) => {
      const input = rawInput.trim()
      if (input === 'off') {
        const state = await controller.deactivate(agent)
        if (state === undefined || state.active) return { kind: 'success', text: 'Discussion Mode is not active.' }
        return { kind: 'success', text: `Discussion Mode paused. ${checkpointSuffix(state)}` }
      }
      const acceptMatch = /^accept\s+(\S+)$/u.exec(input)
      if (acceptMatch?.[1] !== undefined) {
        try {
          const state = await controller.accept(agent, acceptMatch[1])
          return { kind: 'success', text: `Pending Frame Change accepted: ${acceptMatch[1]}. ${checkpointSuffix(state)}` }
        } catch (error: unknown) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      const rejectMatch = /^reject\s+(\S+)$/u.exec(input)
      if (rejectMatch?.[1] !== undefined) {
        try {
          const state = await controller.reject(agent, rejectMatch[1])
          return { kind: 'success', text: `Pending Frame Change rejected: ${rejectMatch[1]}. ${checkpointSuffix(state)}` }
        } catch (error: unknown) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      const current = controller.get(agent)
      const intensity = input === '' ? current?.intensity ?? config.defaultIntensity : parseIntensity(input)
      if (intensity === undefined) return { kind: 'error', text: `Usage: ${USAGE}` }
      const state = await controller.activate(agent, intensity)
      const topicNote = state.provisionalTitle === UNTITLED_TITLE
        ? 'No topic yet. The next user message starts the discussion.'
        : `Title unchanged: ${state.provisionalTitle}.`
      return {
        kind: 'success',
        text: `Discussion Mode: ${String(state.intensity)}=${intensityName(state.intensity)}. Intensity only. ${topicNote} Use /discussion off to leave. ${checkpointSuffix(state)}`,
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

  ctx.inject(['subagents'], subagentCtx => {
    subagentCtx.effect(
      () => wrapSubagents(subagentCtx),
      'discussion-intent:subagent-flash',
    )
  })
}
