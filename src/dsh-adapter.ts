/**
 * DSH host adapter: the single named boundary where this plugin imports DSH
 * host packages and wires host services (slash command, model tool,
 * system-prompt section, Web Rail transport, optional subagent-model wrap,
 * session read). The public package entry (`index.ts`) is a thin facade over
 * this module. Domain logic stays DSH-independent in `contract.ts`,
 * `sidecar.ts`, `subagent-model.ts`, and `capabilities.ts`.
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
  type SubagentRailStatus,
} from './contract.ts'
import {
  DEFAULT_DIRECTORY,
  discussionSidecarRevisionSync,
  discussionStateJsonPath,
  readDiscussionSidecarSync,
  writeDiscussionSidecar,
} from './sidecar.ts'
import {
  formatSubagentModelCommandResult,
  listAvailableModels,
  materializeSpawnEffort,
  mergeChildAgentOptions,
  parseCustomRoute,
  readStoredRoute,
  SUBAGENT_MODEL_QUESTION_ID,
  SubagentModelSelection,
  SubagentRailTracker,
  type ChildAgentOptionsLike,
  type ChildRoute,
  type LlmLike,
  type SettingsLike,
  type UserQuestionsLike,
} from './subagent-model.ts'

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

const USAGE = '/discussion [1=fast | 2=default | 3=deep] or /discussion model [<provider>/<id>] or /discussion accept <id> or /discussion reject <id> or /discussion off'
const COMMAND_HINT = '[1=fast | 2=default | 3=deep | model [<provider>/<id>] | accept <id> | reject <id> | off]'
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

function openingUserSeq(session: Session): number | undefined {
  for (const event of session.events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') return event.seq
  }
  return undefined
}

function latestEventSeq(session: Session): number {
  const last = session.events.at(-1)
  return last === undefined ? 0 : last.seq
}

function toolResultText(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const texts: string[] = []
  for (const block of event.data.message.content) {
    for (const inner of block.content) {
      if (inner.type === 'text') texts.push(inner.text)
    }
  }
  const text = texts.join('\n').trim()
  return text === '' ? undefined : text
}

function askAnswerQuotes(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { readonly answers?: unknown }
    if (!Array.isArray(parsed.answers)) return []
    const quotes: string[] = []
    for (const answer of parsed.answers) {
      if (typeof answer !== 'object' || answer === null) continue
      const item = answer as { readonly custom?: unknown; readonly selected?: unknown }
      if (typeof item.custom === 'string' && item.custom.trim() !== '') quotes.push(item.custom.trim())
      if (!Array.isArray(item.selected)) continue
      for (const label of item.selected) {
        if (typeof label === 'string' && label.trim() !== '') quotes.push(label.trim())
      }
    }
    return quotes
  } catch {
    return []
  }
}

function isAskUserQuestionResult(session: Session, event: SessionEvent): boolean {
  if (event.type !== 'tool/result') return false
  const callId = event.data.message.source.kind === 'tool' ? event.data.message.source.callId : undefined
  if (callId !== undefined) {
    const call = session.events.find(item => item.type === 'tool/call' && item.data.callId === callId)
    if (call !== undefined && call.type === 'tool/call') return call.data.name === 'ask_user_question'
  }
  const text = toolResultText(event)
  return text !== undefined && askAnswerQuotes(text).length > 0
}

function askUserQuestionContains(session: Session, event: SessionEvent, quote: string): boolean {
  if (!isAskUserQuestionResult(session, event)) return false
  const text = toolResultText(event)
  return text !== undefined && askAnswerQuotes(text).some(item => item.includes(quote))
}

function resolveCapture(agent: Agent, capture: CaptureRequest): ResolvedCapture {
  const quote = capture.quote.trim()
  if (quote === '') throw new Error('capture quote must not be empty.')
  const events = agent.session.events
  const userCandidate = capture.eventSeq === undefined
    ? [...events].reverse().find(event => directUserText(event)?.includes(quote))
    : events.find(event => event.seq === capture.eventSeq)
  const sourceText = userCandidate === undefined ? undefined : directUserText(userCandidate)
  if (userCandidate !== undefined && sourceText !== undefined && sourceText.includes(quote)) {
    return {
      kind: capture.kind,
      quote,
      eventSeq: userCandidate.seq,
      ...(capture.normalizedRestatement === undefined ? {} : { normalizedRestatement: capture.normalizedRestatement }),
    }
  }
  const askCandidate = capture.eventSeq === undefined
    ? [...events].reverse().find(event => askUserQuestionContains(agent.session, event, quote))
    : events.find(event => event.seq === capture.eventSeq)
  if (askCandidate !== undefined && askUserQuestionContains(agent.session, askCandidate, quote)) {
    return {
      kind: capture.kind,
      quote,
      eventSeq: askCandidate.seq,
      origin: 'ask_user_question',
      ...(capture.normalizedRestatement === undefined ? {} : { normalizedRestatement: capture.normalizedRestatement }),
    }
  }
  throw new Error(`No same-session direct user message contains the exact quote ${JSON.stringify(quote)}.`)
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
    if (next === current) {
      this.publish(agent.session.id, next)
      return next
    }
    return this.commit(agent, next)
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
    return this.commit(agent, applyDiscussionUpdate(current, update, Date.now(), openingUserSeq(agent.session)))
  }

  async recordAskDecisions(
    agent: Agent,
    answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[],
  ): Promise<DiscussionState | undefined> {
    const current = this.get(agent)
    if (current === undefined || !current.active) return current
    const quotes: string[] = []
    for (const answer of answers) {
      if (answer.id === SUBAGENT_MODEL_QUESTION_ID) continue
      if (answer.custom !== undefined && answer.custom.trim() !== '') quotes.push(answer.custom.trim())
      for (const label of answer.selected) {
        if (label.trim() !== '') quotes.push(label.trim())
      }
    }
    if (quotes.length === 0) return current
    const eventSeq = latestEventSeq(agent.session)
    return this.commit(agent, applyDiscussionUpdate(current, {
      expectedRevision: current.revision,
      captures: quotes.map(quote => ({
        kind: 'decision',
        quote,
        eventSeq,
        origin: 'ask_user_question',
      })),
    }, Date.now(), openingUserSeq(agent.session)))
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
    this.publish(session.id, checkpointed)
    return checkpointed
  }

  private publish(sessionId: string, state: DiscussionState): void {
    this.ctx.emit('discussion-intent/change', sessionId, state)
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
    description: 'Update the active Discussion state after visible prose, before a substantive discussion reply, before spawning a subagent, and after each bounded return. Capture quoted user statements, add candidate options or evidence, and revise the provisional interpretation. Write benefit, cost, assumption, and consequence into optionUpdates evidenceFor/evidenceAgainst; do not add new option fields. When recommending, put (Recommended) on the first favored option title. historySummary names the closed stage and the opened stage at a material decision, a settled stage, or an authorized next action. Title, goal, and root-focus writes become Pending Frame Changes; they do not apply until /discussion accept <id>. A focus write with returnTo that names the locked root (or the current working focus when the root is empty) is a working-focus dive; changing the root question still stays Pending. Direct-user captures must quote an exact same-session user message or an ask_user_question option label/custom. supersedeStatementIds requires a new same-session proving quote in the same call. Same-turn order: visible prose → discussion_update → then ask_user_question if needed.',
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
        description: 'Working-focus dive when returnTo exactly names the locked root (or current working focus if the root is empty) at a deeper level. Other writes become a Pending root-focus change; they do not overwrite the locked question.',
        additionalProperties: false,
        properties: {
          currentQuestion: { type: 'string', required: true },
          level: { type: 'string', required: true, enum: FOCUS_LEVELS },
          returnTo: { type: 'string', description: 'Higher-level question to return to after this sub-question.' },
        },
      },
      optionUpdates: {
        type: 'array',
        description: 'Incremental upserts for candidate alternatives and their evidence. Write benefit, cost, assumption, and consequence into evidenceFor/evidenceAgainst. Do not add new option fields. Candidates stay candidates; promoting one to the root question is a pending change. When recommending, the first favored option title should include (Recommended).',
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
      historySummary: { type: 'string', description: 'One concise durable note at a Collaborate checkpoint: material decision, settled stage, or authorized next action. Name the closed stage and the opened stage.' },
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
type RailSnapshot =
  | { readonly active: false }
  | (DiscussionState & { readonly subagent: SubagentRailStatus })

interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function railSnapshot(
  state: DiscussionState | undefined,
  subagent: SubagentRailStatus,
): RailSnapshot {
  return state === undefined ? { active: false } : { ...state, subagent }
}

interface AgentSessionLike {
  readonly id?: string
  readonly header?: { readonly id?: string; readonly parentSession?: string }
  requestHeader?(): { readonly config?: { readonly reasoningEffort?: string } } | undefined
}

interface AgentLike {
  readonly id?: string
  readonly options?: ChildAgentOptionsLike
  readonly session?: AgentSessionLike
}

interface SubagentStartRequestLike {
  readonly agentOptions?: ChildAgentOptionsLike
  readonly parent?: AgentLike
}

interface ContinuableStartSpecLike {
  readonly request: SubagentStartRequestLike
}

interface SubagentsLike {
  start: (provider: string, request: SubagentStartRequestLike) => unknown
  startContinuable: (spec: ContinuableStartSpecLike) => unknown
}

const SUBAGENT_MODEL_SETTINGS_SCHEMA = z.object({
  provider: z.string(),
  model: z.string(),
})

/**
 * Live pin for spawn/fork. Selection starts empty; the first start throws
 * until the header chip or `/discussion model` writes settings.
 */
interface AskRequestLike {
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: readonly { readonly label: string; readonly description?: string }[]
  }[]
  readonly agent?: Agent
}

interface AskAnswerLike {
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[]
}

function wrapUserQuestions(ctx: Context, controller: DiscussionIntentController): () => void {
  const userQuestions = ctx.get('userQuestions') as UserQuestionsLike | undefined
  if (userQuestions === undefined) return () => undefined
  const ask = userQuestions.ask.bind(userQuestions)
  userQuestions.ask = async (request: AskRequestLike) => {
    const answer = await ask(request) as AskAnswerLike
    if (request.agent !== undefined) {
      await controller.recordAskDecisions(request.agent, answer.answers)
    }
    return answer
  }
  return () => {
    userQuestions.ask = ask
  }
}

function wrapSubagents(
  ctx: Context,
  selection: SubagentModelSelection,
  tracker: SubagentRailTracker,
): () => void {
  const subagents = ctx.get('subagents') as SubagentsLike | undefined
  if (subagents === undefined) return () => undefined
  const start = subagents.start.bind(subagents)
  const startContinuable = subagents.startContinuable.bind(subagents)

  const rememberEffort = (route: ChildRoute): void => {
    void materializeSpawnEffort(ctx.get('llm') as LlmLike | undefined, route).then(effort => {
      tracker.setEffort(route, effort)
    })
  }

  const pin = async <T extends SubagentStartRequestLike>(request: T): Promise<T> => {
    const route = await selection.ensureChosen()
    tracker.notify()
    rememberEffort(route)
    return {
      ...request,
      agentOptions: mergeChildAgentOptions(request, route),
    }
  }

  subagents.start = async (provider, request) => start(provider, await pin(request))
  subagents.startContinuable = async spec => startContinuable({
    ...spec,
    request: await pin(spec.request),
  })
  return () => {
    subagents.start = start
    subagents.startContinuable = startContinuable
  }
}

function listenSubagentLifecycle(ctx: Context, tracker: SubagentRailTracker): () => void {
  const readChild = (id: unknown): AgentLike | undefined => {
    const agents = ctx.get('agents') as { get?: (agentId: unknown) => AgentLike | undefined } | undefined
    return typeof agents?.get === 'function' ? agents.get(id) : undefined
  }
  const on = ctx.on.bind(ctx) as (
    event: string,
    listener: (info: { readonly id?: unknown }) => void,
  ) => () => void
  const offStart = on('subagent/start', info => {
    if (info.id === undefined) return
    const child = readChild(info.id)
    const parentId = child?.session?.header?.parentSession
    const model = child?.options?.model
    if (typeof parentId !== 'string' || parentId === '' || typeof model !== 'string' || model === '') return
    const provider = child?.options?.provider
    const effort = child?.session?.requestHeader?.()?.config?.reasoningEffort
    tracker.markRunning(String(info.id), parentId, {
      provider: typeof provider === 'string' ? provider : '',
      model,
      ...typeof effort === 'string' && effort !== '' ? { effort } : {},
    })
  })
  const offEnd = on('subagent/end', info => {
    if (info.id !== undefined) tracker.markEnded(String(info.id))
  })
  return () => {
    offStart()
    offEnd()
  }
}

const SESSION_READY_RETRY_ATTEMPTS = 4
const SESSION_READY_RETRY_MS = 20

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  return JSON.parse(raw) as unknown
}

function rememberRouteEffort(
  ctx: Context,
  tracker: SubagentRailTracker,
  route: ChildRoute,
): void {
  void materializeSpawnEffort(ctx.get('llm') as LlmLike | undefined, route).then(effort => {
    tracker.setEffort(route, effort)
  })
}

async function handleSubagentModelCommand(
  ctx: Context,
  selection: SubagentModelSelection,
  tracker: SubagentRailTracker,
  spec: string | undefined,
): Promise<{ readonly kind: 'success' | 'error'; readonly text: string }> {
  if (spec !== undefined) {
    const route = parseCustomRoute(spec)
    if (route === undefined) {
      return { kind: 'error', text: 'Usage: /discussion model <provider>/<id>' }
    }
    await selection.persist(route)
    tracker.notify()
    rememberRouteEffort(ctx, tracker, route)
    return {
      kind: 'success',
      text: `Discussion Mode subagent model set to ${route.provider}/${route.model}. Next spawn uses this model. The parent thread is unchanged.`,
    }
  }
  const llm = ctx.get('llm') as LlmLike | undefined
  const models = llm === undefined ? [] : await listAvailableModels(llm)
  return { kind: 'success', text: formatSubagentModelCommandResult(models, selection.current()) }
}

function registerRailTransport(
  ctx: Context,
  controller: DiscussionIntentController,
  tracker: SubagentRailTracker,
  selection: SubagentModelSelection,
): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined
  const streams = new Map<string, Set<ServerResponse>>()

  function sessionOf(sessionId: string): Session | undefined {
    if (sessionId === '') return undefined
    return ctx.sessions.get(sessionId as SessionId)
  }

  async function waitForSession(sessionId: string): Promise<Session | undefined> {
    for (let attempt = 0; attempt < SESSION_READY_RETRY_ATTEMPTS; attempt += 1) {
      const session = sessionOf(sessionId)
      if (session !== undefined) return session
      if (attempt + 1 < SESSION_READY_RETRY_ATTEMPTS) await delay(SESSION_READY_RETRY_MS)
    }
    return undefined
  }

  function loadReady(sessionId: string): DiscussionState | undefined {
    const session = sessionOf(sessionId)
    return session === undefined ? undefined : controller.load(session)
  }

  async function resolveReady(sessionId: string): Promise<DiscussionState | undefined> {
    const session = await waitForSession(sessionId)
    return session === undefined ? undefined : controller.load(session)
  }

  function snapshotOf(sessionId: string, state: DiscussionState | undefined): RailSnapshot {
    return railSnapshot(state, tracker.status(sessionId))
  }

  function push(sessionId: string, state: DiscussionState): void {
    const listeners = streams.get(sessionId)
    if (listeners === undefined) return
    const payload = `${JSON.stringify(snapshotOf(sessionId, state))}\n`
    for (const response of listeners) response.write(`data: ${payload}\n\n`)
  }

  function pushCurrent(sessionId: string): void {
    const state = loadReady(sessionId)
    if (state !== undefined) push(sessionId, state)
  }

  const offChange = ctx.on('discussion-intent/change', (sessionId, state) => { push(sessionId, state) })

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://discussion-intent.invalid')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (url.pathname === '/dsh/discussion-intent/models') {
      if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"error":"method not allowed"}\n')
        return
      }
      const llm = ctx.get('llm') as LlmLike | undefined
      void (llm === undefined ? Promise.resolve([]) : listAvailableModels(llm)).then(models => {
        const selected = selection.current()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`${JSON.stringify(selected === undefined ? { models } : { models, selected })}\n`)
      }, error => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`)
      })
      return
    }
    if (url.pathname === '/dsh/discussion-intent/subagent') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"error":"method not allowed"}\n')
        return
      }
      void readJsonBody(req).then(async body => {
        const route = readStoredRoute(body)
        if (route === undefined) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"error":"provider and model are required"}\n')
          return
        }
        await selection.persist(route)
        tracker.notify()
        rememberRouteEffort(ctx, tracker, route)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`${JSON.stringify({ ok: true, provider: route.provider, model: route.model })}\n`)
      }, error => {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`)
      })
      return
    }
    if (url.pathname === '/dsh/discussion-intent/state') {
      void resolveReady(sessionId).then(state => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`${JSON.stringify(snapshotOf(sessionId, state))}\n`)
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
      void waitForSession(sessionId).then(session => {
        if (closed) return
        if (session === undefined) {
          res.write(': waiting\n\n')
          return
        }
        res.write(`data: ${JSON.stringify(snapshotOf(sessionId, loadReady(sessionId)))}\n\n`)
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

  const offOverlay = tracker.onChange(() => {
    for (const sessionId of streams.keys()) pushCurrent(sessionId)
  })

  const dispose = webServer.register({ kind: 'prefix', path: '/dsh/discussion-intent', handler })
  return () => {
    dispose()
    offChange()
    offOverlay()
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
  const selection = new SubagentModelSelection()
  const tracker = new SubagentRailTracker(selection)

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
      const modelCommand = /^model(?:\s+(\S+))?$/u.exec(input)
      if (modelCommand !== null) {
        return handleSubagentModelCommand(ctx, selection, tracker, modelCommand[1])
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

  ctx.inject(['settings'], settingsCtx => {
    selection.attachSettings(settingsCtx.get('settings') as SettingsLike, SUBAGENT_MODEL_SETTINGS_SCHEMA)
    tracker.notify()
    const stored = selection.current()
    if (stored !== undefined) {
      void materializeSpawnEffort(settingsCtx.get('llm') as LlmLike | undefined, stored).then(effort => {
        tracker.setEffort(stored, effort)
      })
    }
  })

  ctx.inject(['webServer'], railCtx => {
    railCtx.effect(
      () => registerRailTransport(railCtx, controller, tracker, selection),
      'discussion-intent:rail-transport',
    )
  })

  ctx.inject(['subagents'], subagentCtx => {
    subagentCtx.effect(
      () => wrapSubagents(subagentCtx, selection, tracker),
      'discussion-intent:subagent-model',
    )
  })

  ctx.effect(
    () => listenSubagentLifecycle(ctx, tracker),
    'discussion-intent:subagent-rail',
  )

  ctx.inject(['userQuestions'], questionCtx => {
    questionCtx.effect(
      () => wrapUserQuestions(questionCtx, controller),
      'discussion-intent:ask-capture',
    )
  })
}
