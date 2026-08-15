/** Portable vocabulary for the Discussion Mode plugin's private, plugin-owned state. */

export type DiscussionIntensity = 1 | 2 | 3
export type FocusLevel = 'project' | 'direction' | 'mechanism' | 'experiment' | 'decision'
export type HumanFrameKind = 'goal' | 'constraint' | 'criterion' | 'preference' | 'decision' | 'rejection' | 'non-goal'
export type HumanFrameStatus = 'active' | 'superseded'
export type DiscussionOptionStatus = 'open' | 'favored' | 'rejected'

export interface HumanFrame {
  readonly id: string
  readonly kind: HumanFrameKind
  /** Always identical to source.quote. Model-authored wording lives only in normalizedRestatement. */
  readonly statement: string
  readonly normalizedRestatement?: string
  readonly source: {
    readonly eventSeq: number
    readonly quote: string
  }
  readonly status: HumanFrameStatus
}

export interface DiscussionFocus {
  readonly currentQuestion: string
  readonly level: FocusLevel
  readonly returnTo?: string
}

export interface DiscussionOption {
  readonly id: string
  readonly title: string
  readonly evidenceFor: readonly string[]
  readonly evidenceAgainst: readonly string[]
  readonly status: DiscussionOptionStatus
}

export interface DiscussionSynthesis {
  readonly interpretation: string
  readonly recommendation: string
  readonly openPoint: string
  readonly nextStep: string
}

export interface DiscussionHistoryEntry {
  readonly revision: number
  readonly summary: string
}

export type DiscussionCheckpoint =
  | { readonly status: 'pending' }
  | { readonly status: 'saved'; readonly filePath: string }
  | { readonly status: 'error'; readonly message: string; readonly filePath?: string }

export interface DiscussionState {
  readonly version: 1
  readonly id: string
  readonly active: boolean
  readonly intensity: DiscussionIntensity
  readonly revision: number
  readonly provisionalTitle: string
  readonly goal: string
  readonly humanFrame: readonly HumanFrame[]
  readonly focus: DiscussionFocus
  readonly options: readonly DiscussionOption[]
  readonly synthesis: DiscussionSynthesis
  readonly shortHistory: readonly DiscussionHistoryEntry[]
  readonly checkpoint: DiscussionCheckpoint
  readonly updatedAt: number
}

export interface CaptureRequest {
  readonly kind: HumanFrameKind
  readonly quote: string
  readonly eventSeq?: number
  readonly normalizedRestatement?: string
}

export interface ResolvedCapture extends Omit<CaptureRequest, 'eventSeq'> {
  readonly eventSeq: number
}

export interface DiscussionOptionUpdate {
  readonly id: string
  readonly title?: string
  readonly evidenceFor?: readonly string[]
  readonly evidenceAgainst?: readonly string[]
  readonly status?: DiscussionOptionStatus
}

export interface DiscussionUpdate {
  readonly expectedRevision: number
  readonly provisionalTitle?: string
  readonly goal?: string
  readonly captures?: readonly ResolvedCapture[]
  readonly supersedeStatementIds?: readonly string[]
  readonly focus?: DiscussionFocus
  readonly optionUpdates?: readonly DiscussionOptionUpdate[]
  readonly synthesis?: Partial<DiscussionSynthesis>
  readonly historySummary?: string
}

export interface RailRow {
  readonly label: 'Focus' | 'You' | 'Understanding' | 'Next'
  readonly value: string
  readonly authority: 'human' | 'model'
}

const INTENSITY_NAMES: Record<DiscussionIntensity, string> = {
  1: 'fast',
  2: 'default',
  3: 'deep',
}

const EMPTY_SYNTHESIS: DiscussionSynthesis = {
  interpretation: 'Waiting for a working interpretation.',
  recommendation: 'No recommendation yet.',
  openPoint: 'Infer the most valuable unresolved question from the conversation.',
  nextStep: 'Form a provisional topic and begin the discussion.',
}

export function intensityName(intensity: DiscussionIntensity): string {
  return INTENSITY_NAMES[intensity]
}

export function parseIntensity(value: string): DiscussionIntensity | undefined {
  if (value === '1') return 1
  if (value === '2') return 2
  if (value === '3') return 3
  return undefined
}

export function createDiscussionState(input: {
  readonly id: string
  readonly intensity: DiscussionIntensity
  readonly now: number
}): DiscussionState {
  const state: DiscussionState = {
    version: 1,
    id: requiredText(input.id, 'discussion id'),
    active: true,
    intensity: input.intensity,
    revision: 1,
    provisionalTitle: 'Topic to be distilled',
    goal: 'Distill the real question from the conversation and converge on a valuable answer.',
    humanFrame: [],
    focus: {
      currentQuestion: 'What is the most valuable question in the conversation so far?',
      level: 'project',
    },
    options: [],
    synthesis: EMPTY_SYNTHESIS,
    shortHistory: [{ revision: 1, summary: `Discussion opened at ${intensityName(input.intensity)} intensity.` }],
    checkpoint: { status: 'pending' },
    updatedAt: validTimestamp(input.now),
  }
  assertDiscussionState(state)
  return state
}

/** Activate/resume and optionally change intensity. No event is needed when nothing changes. */
export function activateDiscussion(
  current: DiscussionState | undefined,
  input: { readonly id: string; readonly intensity: DiscussionIntensity; readonly now: number },
): DiscussionState {
  if (current === undefined) return createDiscussionState(input)
  assertDiscussionState(current)
  if (current.active && current.intensity === input.intensity) return current
  const revision = current.revision + 1
  return checked({
    ...current,
    active: true,
    intensity: input.intensity,
    revision,
    shortHistory: appendHistory(current.shortHistory, {
      revision,
      summary: current.active
        ? `Discussion intensity changed to ${intensityName(input.intensity)}.`
        : `Discussion resumed at ${intensityName(input.intensity)} intensity.`,
    }),
    checkpoint: { status: 'pending' },
    updatedAt: validTimestamp(input.now),
  })
}

export function deactivateDiscussion(current: DiscussionState, now: number): DiscussionState {
  assertDiscussionState(current)
  if (!current.active) return current
  const revision = current.revision + 1
  return checked({
    ...current,
    active: false,
    revision,
    shortHistory: appendHistory(current.shortHistory, { revision, summary: 'Discussion paused.' }),
    checkpoint: { status: 'pending' },
    updatedAt: validTimestamp(now),
  })
}

/** Apply one model-owned, source-aware incremental update. */
export function applyDiscussionUpdate(current: DiscussionState, update: DiscussionUpdate, now: number): DiscussionState {
  assertDiscussionState(current)
  if (!current.active) throw new Error('Discussion Mode is not active. Use /discussion first.')
  if (update.expectedRevision !== current.revision) {
    throw new Error(`Discussion revision changed: expected ${String(update.expectedRevision)}, current ${String(current.revision)}. Read current state and retry.`)
  }

  const humanFrame = applyCaptures(
    current.humanFrame,
    update.captures ?? [],
    update.supersedeStatementIds ?? [],
  )
  const options = applyOptionUpdates(current.options, update.optionUpdates ?? [])
  const synthesis = update.synthesis === undefined
    ? current.synthesis
    : {
      interpretation: optionalText(update.synthesis.interpretation, current.synthesis.interpretation, 'interpretation'),
      recommendation: optionalText(update.synthesis.recommendation, current.synthesis.recommendation, 'recommendation'),
      openPoint: optionalText(update.synthesis.openPoint, current.synthesis.openPoint, 'open point'),
      nextStep: optionalText(update.synthesis.nextStep, current.synthesis.nextStep, 'next step'),
    }
  const revision = current.revision + 1
  const changed = update.provisionalTitle !== undefined
    || update.goal !== undefined
    || (update.captures?.length ?? 0) > 0
    || (update.supersedeStatementIds?.length ?? 0) > 0
    || update.focus !== undefined
    || (update.optionUpdates?.length ?? 0) > 0
    || update.synthesis !== undefined
    || update.historySummary !== undefined
  if (!changed) throw new Error('discussion_update must contain at least one material update.')

  const history = update.historySummary === undefined
    ? current.shortHistory
    : appendHistory(current.shortHistory, { revision, summary: requiredText(update.historySummary, 'history summary') })
  return checked({
    ...current,
    revision,
    provisionalTitle: optionalText(update.provisionalTitle, current.provisionalTitle, 'provisional title'),
    goal: optionalText(update.goal, current.goal, 'goal'),
    humanFrame,
    focus: update.focus === undefined ? current.focus : validateFocus(update.focus),
    options,
    synthesis,
    shortHistory: history,
    checkpoint: { status: 'pending' },
    updatedAt: validTimestamp(now),
  })
}

export function withCheckpoint(state: DiscussionState, checkpoint: DiscussionCheckpoint): DiscussionState {
  return checked({ ...state, checkpoint })
}

/** Decode one whole-state snapshot (the JSON sidecar body). Malformed input fails rather than silently degrading. */
export function decodeDiscussionState(value: unknown): DiscussionState {
  assertDiscussionState(value)
  return value
}

export function discussionRailRows(state: DiscussionState): readonly RailRow[] {
  const quotes = state.humanFrame
    .filter(frame => frame.status === 'active')
    .slice(-2)
    .map(frame => frame.statement)
  return [
    { label: 'Focus', value: state.focus.currentQuestion, authority: 'model' },
    { label: 'You', value: quotes.length === 0 ? 'No direct statement captured yet.' : quotes.join(' · '), authority: 'human' },
    { label: 'Understanding', value: state.synthesis.interpretation, authority: 'model' },
    { label: 'Next', value: state.synthesis.nextStep || state.synthesis.openPoint, authority: 'model' },
  ]
}

export function renderDiscussionPolicy(state: DiscussionState): string {
  assertDiscussionState(state)
  const intensity = state.intensity === 1
    ? 'FAST: stay concise; identify the key fork and recommend a next move. Ask no question unless blocked by a user preference.'
    : state.intensity === 2
      ? 'DEFAULT: compare the meaningful alternatives, keep evidence and user criteria visible, and ask at most one high-value preference question when needed.'
      : 'DEEP: reason from first principles and stand on the strongest prior work. Before recommending a direction, identify the strongest prior approach, state the concrete difference, name a falsifiable test, and explain the field-level value. Expose tensions and novel openings, then converge instead of endlessly expanding.'
  const human = state.humanFrame
    .filter(frame => frame.status === 'active')
    .map(frame => `- [${frame.kind}] ${frame.statement}${frame.normalizedRestatement === undefined ? '' : ` (working restatement: ${frame.normalizedRestatement})`}`)
    .join('\n') || '- none captured yet'
  const options = state.options.map(option => `- ${option.id}: ${option.title} [${option.status}]`).join('\n') || '- none yet'
  return [
    'Discussion Mode is active.',
    intensity,
    'Infer the provisional topic and goal from the conversation; the user does not need to provide a topic.',
    'Use the native ask_user_question tool only for preferences, boundaries, or direction choices. Research discoverable facts yourself. Ask one question at a time.',
    'Keep direct user quotes separate from model synthesis. Never present a normalized restatement as the user\'s words.',
    'Before every substantive discussion reply, call discussion_update so the durable state and Markdown checkpoint stay current.',
    'Return to the current focus when exploration drifts. Preserve rejected directions and decisive evidence in options/history. Converge to a recommendation and next step when the evidence is sufficient.',
    `Revision: ${String(state.revision)}. Title: ${state.provisionalTitle}`,
    `Goal: ${state.goal}`,
    `Focus (${state.focus.level}): ${state.focus.currentQuestion}`,
    'Direct user frame:',
    human,
    'Options:',
    options,
    `Working interpretation: ${state.synthesis.interpretation}`,
    `Recommendation: ${state.synthesis.recommendation}`,
    `Open point: ${state.synthesis.openPoint}`,
    `Next step: ${state.synthesis.nextStep}`,
  ].join('\n')
}

export function renderDiscussionMarkdown(state: DiscussionState): string {
  assertDiscussionState(state)
  const human = state.humanFrame.length === 0
    ? '- No direct user statements captured yet.'
    : state.humanFrame.map(frame => {
      const suffix = frame.normalizedRestatement === undefined ? '' : `\n  - Working restatement: ${frame.normalizedRestatement}`
      return `- **${frame.kind} · ${frame.status}** — “${frame.statement}” (session event ${String(frame.source.eventSeq)})${suffix}`
    }).join('\n')
  const options = state.options.length === 0
    ? '- No options mapped yet.'
    : state.options.map(option => [
      `### ${option.title} \`${option.status}\``,
      '',
      option.evidenceFor.length === 0 ? '- Evidence for: none yet' : `- Evidence for: ${option.evidenceFor.join('; ')}`,
      option.evidenceAgainst.length === 0 ? '- Evidence against: none yet' : `- Evidence against: ${option.evidenceAgainst.join('; ')}`,
    ].join('\n')).join('\n\n')
  const history = state.shortHistory.map(entry => `- r${String(entry.revision)} — ${entry.summary}`).join('\n')
  return [
    `# ${state.provisionalTitle}`,
    '',
    `> Discussion Mode · ${String(state.intensity)}=${intensityName(state.intensity)} · revision ${String(state.revision)} · ${state.active ? 'active' : 'paused'}`,
    '',
    '## Goal', '', state.goal,
    '', '## Current Focus', '', `- Level: ${state.focus.level}`, `- Question: ${state.focus.currentQuestion}`,
    ...(state.focus.returnTo === undefined ? [] : [`- Return to: ${state.focus.returnTo}`]),
    '', '## User Frame', '', human,
    '', '## Options and Evidence', '', options,
    '', '## Working Synthesis', '',
    `- Interpretation: ${state.synthesis.interpretation}`,
    `- Recommendation: ${state.synthesis.recommendation}`,
    `- Open point: ${state.synthesis.openPoint}`,
    `- Next step: ${state.synthesis.nextStep}`,
    '', '## Recent Discussion History', '', history,
    '', '<!-- Generated by @jinplu/dsh-plugin-discussion-intent. The companion JSON sidecar is the authoritative state. -->', '',
  ].join('\n')
}

export function assertDiscussionState(value: unknown): asserts value is DiscussionState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Discussion state must be an object.')
  const state = value as DiscussionState
  if (state.version !== 1) throw new Error('Unsupported Discussion state version.')
  requiredText(state.id, 'discussion id')
  if (typeof state.active !== 'boolean') throw new Error('Discussion active must be boolean.')
  if (parseIntensity(String(state.intensity)) === undefined) throw new Error('Discussion intensity must be 1, 2, or 3.')
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error('Discussion revision must be a positive integer.')
  requiredText(state.provisionalTitle, 'provisional title')
  requiredText(state.goal, 'goal')
  if (!Array.isArray(state.humanFrame)) throw new Error('Human Frame must be an array.')
  const humanIds = new Set<string>()
  const humanKinds: readonly HumanFrameKind[] = ['goal', 'constraint', 'criterion', 'preference', 'decision', 'rejection', 'non-goal']
  const humanStatuses: readonly HumanFrameStatus[] = ['active', 'superseded']
  for (const frame of state.humanFrame) {
    requiredText(frame.id, 'Human Frame id')
    if (humanIds.has(frame.id)) throw new Error(`Duplicate Human Frame id ${frame.id}.`)
    humanIds.add(frame.id)
    requiredText(frame.statement, 'Human Frame statement')
    requiredText(frame.source.quote, 'Human Frame source quote')
    if (frame.statement !== frame.source.quote) throw new Error('HumanFrame.statement must equal source.quote.')
    if (!Number.isSafeInteger(frame.source.eventSeq) || frame.source.eventSeq < 0) throw new Error('Human Frame eventSeq must be non-negative.')
    if (!humanKinds.includes(frame.kind)) throw new Error(`Unknown Human Frame kind ${String(frame.kind)}.`)
    if (!humanStatuses.includes(frame.status)) throw new Error(`Unknown Human Frame status ${String(frame.status)}.`)
  }
  validateFocus(state.focus)
  if (!Array.isArray(state.options)) throw new Error('Discussion options must be an array.')
  const optionIds = new Set<string>()
  const optionStatuses: readonly DiscussionOptionStatus[] = ['open', 'favored', 'rejected']
  for (const option of state.options) {
    requiredText(option.id, 'option id')
    requiredText(option.title, 'option title')
    if (optionIds.has(option.id)) throw new Error(`Duplicate option id ${option.id}.`)
    optionIds.add(option.id)
    stringList(option.evidenceFor, 'evidenceFor')
    stringList(option.evidenceAgainst, 'evidenceAgainst')
    if (!optionStatuses.includes(option.status)) throw new Error(`Unknown option status ${String(option.status)}.`)
  }
  requiredText(state.synthesis.interpretation, 'interpretation')
  requiredText(state.synthesis.recommendation, 'recommendation')
  requiredText(state.synthesis.openPoint, 'open point')
  requiredText(state.synthesis.nextStep, 'next step')
  if (!Array.isArray(state.shortHistory)) throw new Error('Discussion history must be an array.')
  for (const entry of state.shortHistory) {
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error('History revision must be positive.')
    requiredText(entry.summary, 'history summary')
  }
  validTimestamp(state.updatedAt)
  if (state.checkpoint.status === 'saved') requiredText(state.checkpoint.filePath, 'checkpoint file path')
  if (state.checkpoint.status === 'error') requiredText(state.checkpoint.message, 'checkpoint error')
  if (!['pending', 'saved', 'error'].includes(state.checkpoint.status)) throw new Error('Unknown checkpoint status.')
}

function applyCaptures(
  current: readonly HumanFrame[],
  captures: readonly ResolvedCapture[],
  supersedeIds: readonly string[],
): readonly HumanFrame[] {
  const superseded = new Set(supersedeIds.map(id => requiredText(id, 'superseded Human Frame id')))
  for (const id of superseded) {
    if (!current.some(frame => frame.id === id)) throw new Error(`Unknown Human Frame id ${id}.`)
  }
  const next = current.map(frame => superseded.has(frame.id) ? { ...frame, status: 'superseded' as const } : frame)
  for (const capture of captures) {
    const quote = requiredText(capture.quote, 'capture quote')
    if (!Number.isSafeInteger(capture.eventSeq) || capture.eventSeq < 0) throw new Error('Capture eventSeq must be non-negative.')
    if (next.some(frame => frame.source.eventSeq === capture.eventSeq && frame.statement === quote && frame.kind === capture.kind)) continue
    next.push({
      id: `statement-${String(capture.eventSeq)}-${String(next.length + 1)}`,
      kind: capture.kind,
      statement: quote,
      ...(capture.normalizedRestatement === undefined ? {} : { normalizedRestatement: requiredText(capture.normalizedRestatement, 'normalized restatement') }),
      source: { eventSeq: capture.eventSeq, quote },
      status: 'active',
    })
  }
  return next
}

function applyOptionUpdates(current: readonly DiscussionOption[], updates: readonly DiscussionOptionUpdate[]): readonly DiscussionOption[] {
  const next = current.map(option => ({ ...option, evidenceFor: [...option.evidenceFor], evidenceAgainst: [...option.evidenceAgainst] }))
  for (const update of updates) {
    const id = requiredText(update.id, 'option id')
    const index = next.findIndex(option => option.id === id)
    if (index < 0) {
      next.push({
        id,
        title: requiredText(update.title, 'new option title'),
        evidenceFor: stringList(update.evidenceFor ?? [], 'evidenceFor'),
        evidenceAgainst: stringList(update.evidenceAgainst ?? [], 'evidenceAgainst'),
        status: update.status ?? 'open',
      })
      continue
    }
    const previous = next[index]
    if (previous === undefined) continue
    next[index] = {
      ...previous,
      ...(update.title === undefined ? {} : { title: requiredText(update.title, 'option title') }),
      ...(update.evidenceFor === undefined ? {} : {
        evidenceFor: mergeEvidence(previous.evidenceFor, stringList(update.evidenceFor, 'evidenceFor')),
      }),
      ...(update.evidenceAgainst === undefined ? {} : {
        evidenceAgainst: mergeEvidence(previous.evidenceAgainst, stringList(update.evidenceAgainst, 'evidenceAgainst')),
      }),
      ...(update.status === undefined ? {} : { status: update.status }),
    }
  }
  return next
}

function mergeEvidence(current: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...current, ...incoming])]
}

function appendHistory(
  current: readonly DiscussionHistoryEntry[],
  entry: DiscussionHistoryEntry,
): readonly DiscussionHistoryEntry[] {
  return [...current, entry].slice(-12)
}

function validateFocus(focus: DiscussionFocus): DiscussionFocus {
  const currentQuestion = requiredText(focus.currentQuestion, 'focus question')
  const levels: readonly FocusLevel[] = ['project', 'direction', 'mechanism', 'experiment', 'decision']
  if (!levels.includes(focus.level)) throw new Error(`Unknown focus level ${String(focus.level)}.`)
  return {
    currentQuestion,
    level: focus.level,
    ...(focus.returnTo === undefined ? {} : { returnTo: requiredText(focus.returnTo, 'return focus') }),
  }
}

function stringList(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  return values.map(value => requiredText(value, label))
}

function optionalText(value: string | undefined, fallback: string, label: string): string {
  return value === undefined ? fallback : requiredText(value, label)
}

function requiredText(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must not be empty.`)
  return value.trim()
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('updatedAt must be a non-negative integer timestamp.')
  return value
}

function checked(state: DiscussionState): DiscussionState {
  assertDiscussionState(state)
  return state
}
