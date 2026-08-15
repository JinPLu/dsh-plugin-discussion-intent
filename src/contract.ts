/** Portable vocabulary for the Discussion Mode plugin's private, plugin-owned state. */

export type DiscussionIntensity = 1 | 2 | 3
export type FocusLevel = 'project' | 'direction' | 'mechanism' | 'experiment' | 'decision'
export type HumanFrameKind = 'goal' | 'constraint' | 'criterion' | 'preference' | 'decision' | 'rejection' | 'non-goal'
export type HumanFrameStatus = 'active' | 'superseded'
export type DiscussionOptionStatus = 'open' | 'favored' | 'rejected'
export type PendingFrameChangeTarget = 'title' | 'goal' | 'root-focus' | 'human-frame' | 'rejection'
export type PendingFrameChangeStatus = 'pending' | 'accepted' | 'rejected'

export const UNTITLED_TITLE = 'Untitled'
export const NO_TOPIC_YET = 'No topic yet.'

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

export interface PendingFrameChangeResolution {
  readonly action: 'accepted' | 'rejected'
  readonly resolvedAt: number
}

export interface PendingFrameChange {
  readonly id: string
  readonly status: PendingFrameChangeStatus
  readonly target: PendingFrameChangeTarget
  readonly previous: string
  readonly proposed: string
  readonly impact: string
  readonly question: string
  readonly createdAtRevision: number
  readonly focusLevel?: FocusLevel
  readonly returnTo?: string
  readonly targetFrameId?: string
  readonly resolution?: PendingFrameChangeResolution
}

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
  readonly pendingFrameChanges: readonly PendingFrameChange[]
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
  readonly label: 'Focus' | 'You' | 'Understanding' | 'Next' | 'Pending'
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
  openPoint: NO_TOPIC_YET,
  nextStep: 'The next user message starts the discussion. Do not invent a topic.',
}

const PENDING_TARGETS: readonly PendingFrameChangeTarget[] = ['title', 'goal', 'root-focus', 'human-frame', 'rejection']
const PENDING_STATUSES: readonly PendingFrameChangeStatus[] = ['pending', 'accepted', 'rejected']

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
    provisionalTitle: UNTITLED_TITLE,
    goal: NO_TOPIC_YET,
    humanFrame: [],
    focus: {
      currentQuestion: NO_TOPIC_YET,
      level: 'project',
    },
    options: [],
    synthesis: EMPTY_SYNTHESIS,
    pendingFrameChanges: [],
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

/** Apply one model-owned, source-aware incremental update. Protected fields become pending. */
export function applyDiscussionUpdate(current: DiscussionState, update: DiscussionUpdate, now: number): DiscussionState {
  assertDiscussionState(current)
  if (!current.active) throw new Error('Discussion Mode is not active. Use /discussion first.')
  if (update.expectedRevision !== current.revision) {
    throw new Error(`Discussion revision changed: expected ${String(update.expectedRevision)}, current ${String(current.revision)}. Read current state and retry.`)
  }

  const captures = update.captures ?? []
  const supersedeIds = update.supersedeStatementIds ?? []
  if (supersedeIds.length > 0 && captures.length === 0) {
    throw new Error('supersedeStatementIds requires a new same-session proving quote in the same call.')
  }

  const captured = applyCaptures(current.humanFrame, captures, supersedeIds)
  if (supersedeIds.length > 0 && captured.addedCount === 0) {
    throw new Error('supersedeStatementIds requires a new same-session proving quote in the same call.')
  }

  const installed = installHumanMainline(current, captured.added)
  const options = applyOptionUpdates(current.options, update.optionUpdates ?? [])
  const synthesis = update.synthesis === undefined
    ? current.synthesis
    : {
      interpretation: optionalText(update.synthesis.interpretation, current.synthesis.interpretation, 'interpretation'),
      recommendation: optionalText(update.synthesis.recommendation, current.synthesis.recommendation, 'recommendation'),
      openPoint: optionalText(update.synthesis.openPoint, current.synthesis.openPoint, 'open point'),
      nextStep: optionalText(update.synthesis.nextStep, current.synthesis.nextStep, 'next step'),
    }
  assertNoLockedContradiction(captured.frames, update, options, synthesis)
  const revision = current.revision + 1
  const pendingAdditions = collectProtectedProposals({
    ...current,
    goal: installed.goal,
    focus: installed.focus,
  }, update, revision)
  const changed = (update.captures?.length ?? 0) > 0
    || supersedeIds.length > 0
    || (update.optionUpdates?.length ?? 0) > 0
    || update.synthesis !== undefined
    || update.historySummary !== undefined
    || pendingAdditions.length > 0
  if (!changed) throw new Error('discussion_update must contain at least one material update.')

  const history = update.historySummary === undefined
    ? current.shortHistory
    : appendHistory(current.shortHistory, { revision, summary: requiredText(update.historySummary, 'history summary') })
  return checked({
    ...current,
    revision,
    goal: installed.goal,
    focus: installed.focus,
    humanFrame: captured.frames,
    options,
    synthesis,
    pendingFrameChanges: [...current.pendingFrameChanges, ...pendingAdditions],
    shortHistory: history,
    checkpoint: { status: 'pending' },
    updatedAt: validTimestamp(now),
  })
}

export function acceptPendingFrameChange(current: DiscussionState, id: string, now: number): DiscussionState {
  return resolvePendingFrameChange(current, id, 'accepted', now)
}

export function rejectPendingFrameChange(current: DiscussionState, id: string, now: number): DiscussionState {
  return resolvePendingFrameChange(current, id, 'rejected', now)
}

export function withCheckpoint(state: DiscussionState, checkpoint: DiscussionCheckpoint): DiscussionState {
  return checked({ ...state, checkpoint })
}

/** Decode one whole-state snapshot (the JSON sidecar body). Malformed input fails rather than silently degrading. */
export function decodeDiscussionState(value: unknown): DiscussionState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Discussion state must be an object.')
  const raw = value as DiscussionState & { readonly pendingFrameChanges?: unknown }
  const state = {
    ...raw,
    pendingFrameChanges: Array.isArray(raw.pendingFrameChanges) ? raw.pendingFrameChanges : [],
  }
  assertDiscussionState(state)
  return state
}

export function activePendingFrameChanges(state: DiscussionState): readonly PendingFrameChange[] {
  return state.pendingFrameChanges.filter(change => change.status === 'pending')
}

export function discussionRailRows(state: DiscussionState): readonly RailRow[] {
  const active = state.humanFrame.filter(frame => frame.status === 'active')
  const locks = active.filter(frame => frame.kind === 'rejection' || frame.kind === 'decision')
  const quotes = (locks.length > 0 ? locks : active).map(frame => frame.statement)
  const pending = activePendingFrameChanges(state)
  const rows: RailRow[] = [
    { label: 'Focus', value: state.focus.currentQuestion, authority: 'model' },
    { label: 'You', value: quotes.length === 0 ? 'No direct statement captured yet.' : quotes.join(' · '), authority: 'human' },
    { label: 'Understanding', value: state.synthesis.interpretation, authority: 'model' },
    { label: 'Next', value: state.synthesis.nextStep || state.synthesis.openPoint, authority: 'model' },
  ]
  if (pending.length > 0) {
    rows.push({
      label: 'Pending',
      value: pending.map(change => (
        `${change.id}: ${change.target} → ${change.proposed} (/discussion accept ${change.id} | /discussion reject ${change.id})`
      )).join(' · '),
      authority: 'model',
    })
  }
  return rows
}

export function renderDiscussionPolicy(state: DiscussionState): string {
  assertDiscussionState(state)
  const intensity = state.intensity === 1
    ? 'FAST: stay concise; identify the key fork and recommend a next move. Ask no question unless blocked by a user preference.'
    : state.intensity === 2
      ? 'DEFAULT: compare the meaningful alternatives, keep evidence and user criteria visible, and ask at most one high-value preference question when needed.'
      : 'DEEP: reason from first principles and stand on the strongest prior work. Before recommending a direction, identify the strongest prior approach, state the concrete difference, name a falsifiable test, and explain the field-level value. Expose tensions and novel openings, then converge instead of endlessly expanding.'
  const activeFrames = state.humanFrame.filter(frame => frame.status === 'active')
  const prioritized = [
    ...activeFrames.filter(frame => frame.kind === 'rejection' || frame.kind === 'decision'),
    ...activeFrames.filter(frame => frame.kind !== 'rejection' && frame.kind !== 'decision'),
  ]
  const human = prioritized
    .map(frame => `- [${frame.kind}] ${frame.statement}${frame.normalizedRestatement === undefined ? '' : ` (working restatement: ${frame.normalizedRestatement})`}`)
    .join('\n') || '- none captured yet'
  const options = state.options.map(option => `- ${option.id}: ${option.title} [${option.status}]`).join('\n') || '- none yet'
  const pending = activePendingFrameChanges(state)
  const pendingLines = pending.length === 0
    ? '- none'
    : pending.map(change => `- ${change.id} [${change.target}] ${change.previous} → ${change.proposed}. ${change.question} Use /discussion accept ${change.id} or /discussion reject ${change.id}.`).join('\n')
  return [
    'Discussion Mode is active.',
    intensity,
    'Do not invent or install a topic. Intensity is already set. The discussion stays untitled until the user states a question or accepts a pending topic.',
    'Use the native ask_user_question tool only for preferences, boundaries, or direction choices. Research discoverable facts yourself. Ask one question at a time.',
    'Keep direct user quotes separate from model synthesis. Never present a normalized restatement as the user\'s words.',
    'Before every substantive discussion reply, call discussion_update so the durable state and Markdown checkpoint stay current.',
    'discussion_update may capture quoted user statements, add candidate options or evidence, and revise the provisional interpretation. It may propose a title, goal, or root-focus change; those become Pending Frame Changes. It cannot silently replace title, goal, root focus, Human Frames, or recorded rejections. A captured decision or goal quote installs Focus from that wording when Focus is still empty; a captured goal quote also fills an empty Goal. Recommendation, next step, and favored options must not contradict active rejection or non-goal frames.',
    'Active Human Frames are authoritative every turn, especially rejection and decision frames. New papers, tool results, and research evidence stay candidates. They cannot replace active Human Frames or the locked question.',
    'supersedeStatementIds requires a new same-session proving quote in the same call.',
    'Return to the current focus when exploration drifts. Preserve rejected directions and decisive evidence in options/history. Converge to a recommendation and next step when the evidence is sufficient.',
    `Revision: ${String(state.revision)}. Title: ${state.provisionalTitle}`,
    `Goal: ${state.goal}`,
    `Focus (${state.focus.level}): ${state.focus.currentQuestion}`,
    'Direct user frame:',
    human,
    'Pending Frame Changes:',
    pendingLines,
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
  const pending = state.pendingFrameChanges.length === 0
    ? '- No pending frame changes.'
    : state.pendingFrameChanges.map(change => (
      `- **${change.id} · ${change.status} · ${change.target}** — ${change.previous} → ${change.proposed}${change.status === 'pending' ? ` (/discussion accept ${change.id} | /discussion reject ${change.id})` : ''}`
    )).join('\n')
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
    '', '## Pending Frame Changes', '', pending,
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
  if (!Array.isArray(state.pendingFrameChanges)) throw new Error('Pending Frame Changes must be an array.')
  const pendingIds = new Set<string>()
  for (const change of state.pendingFrameChanges) {
    requiredText(change.id, 'pending frame change id')
    if (pendingIds.has(change.id)) throw new Error(`Duplicate pending frame change id ${change.id}.`)
    pendingIds.add(change.id)
    if (!PENDING_TARGETS.includes(change.target)) throw new Error(`Unknown pending frame change target ${String(change.target)}.`)
    if (!PENDING_STATUSES.includes(change.status)) throw new Error(`Unknown pending frame change status ${String(change.status)}.`)
    requiredText(change.previous, 'pending previous')
    requiredText(change.proposed, 'pending proposed')
    requiredText(change.impact, 'pending impact')
    requiredText(change.question, 'pending question')
    if (!Number.isSafeInteger(change.createdAtRevision) || change.createdAtRevision < 1) {
      throw new Error('Pending frame change createdAtRevision must be a positive integer.')
    }
    if (change.focusLevel !== undefined) validateFocus({ currentQuestion: change.proposed, level: change.focusLevel, ...(change.returnTo === undefined ? {} : { returnTo: change.returnTo }) })
    if (change.targetFrameId !== undefined) requiredText(change.targetFrameId, 'pending target frame id')
    if (change.status === 'pending') {
      if (change.resolution !== undefined) throw new Error('A pending frame change cannot carry a resolution.')
    } else {
      if (change.resolution === undefined) throw new Error('A resolved frame change must carry a resolution.')
      if (change.resolution.action !== change.status) throw new Error('Pending frame change resolution must match status.')
      validTimestamp(change.resolution.resolvedAt)
    }
  }
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

function collectProtectedProposals(
  current: DiscussionState,
  update: DiscussionUpdate,
  revision: number,
): readonly PendingFrameChange[] {
  const additions: PendingFrameChange[] = []
  const push = (change: Omit<PendingFrameChange, 'id' | 'status' | 'createdAtRevision'>): void => {
    additions.push({
      ...change,
      id: `change-${String(revision)}-${String(additions.length + 1)}`,
      status: 'pending',
      createdAtRevision: revision,
    })
  }
  if (update.provisionalTitle !== undefined) {
    const proposed = requiredText(update.provisionalTitle, 'provisional title')
    if (proposed !== current.provisionalTitle) {
      push({
        target: 'title',
        previous: current.provisionalTitle,
        proposed,
        impact: 'Would replace the discussion title.',
        question: `Accept the proposed title “${proposed}”?`,
      })
    }
  }
  if (update.goal !== undefined) {
    const proposed = requiredText(update.goal, 'goal')
    if (proposed !== current.goal) {
      push({
        target: 'goal',
        previous: current.goal,
        proposed,
        impact: 'Would replace the discussion goal.',
        question: `Accept the proposed goal “${proposed}”?`,
      })
    }
  }
  if (update.focus !== undefined) {
    const proposed = validateFocus(update.focus)
    const same = proposed.currentQuestion === current.focus.currentQuestion
      && proposed.level === current.focus.level
      && proposed.returnTo === current.focus.returnTo
    if (!same) {
      push({
        target: 'root-focus',
        previous: current.focus.currentQuestion,
        proposed: proposed.currentQuestion,
        impact: 'Would replace the root focus question.',
        question: `Accept the proposed root focus “${proposed.currentQuestion}”?`,
        focusLevel: proposed.level,
        ...(proposed.returnTo === undefined ? {} : { returnTo: proposed.returnTo }),
      })
    }
  }
  return additions
}

function resolvePendingFrameChange(
  current: DiscussionState,
  id: string,
  action: 'accepted' | 'rejected',
  now: number,
): DiscussionState {
  assertDiscussionState(current)
  if (!current.active) throw new Error('Discussion Mode is not active. Use /discussion first.')
  const changeId = requiredText(id, 'pending frame change id')
  const index = current.pendingFrameChanges.findIndex(change => change.id === changeId)
  const change = current.pendingFrameChanges[index]
  if (change === undefined || change.status !== 'pending') {
    throw new Error(`Pending Frame Change ${changeId} is missing or already resolved.`)
  }
  const revision = current.revision + 1
  const resolvedAt = validTimestamp(now)
  const pendingFrameChanges = current.pendingFrameChanges.map((item, itemIndex) => (
    itemIndex === index
      ? { ...item, status: action, resolution: { action, resolvedAt } }
      : item
  ))
  const applied = action === 'accepted' ? applyAcceptedChange(current, change) : current
  return checked({
    ...applied,
    revision,
    pendingFrameChanges,
    shortHistory: appendHistory(current.shortHistory, {
      revision,
      summary: `${action === 'accepted' ? 'Accepted' : 'Rejected'} pending ${change.target} change ${change.id}.`,
    }),
    checkpoint: { status: 'pending' },
    updatedAt: resolvedAt,
  })
}

function applyAcceptedChange(current: DiscussionState, change: PendingFrameChange): Pick<DiscussionState, 'provisionalTitle' | 'goal' | 'focus'> & DiscussionState {
  if (change.target === 'title') return { ...current, provisionalTitle: requiredText(change.proposed, 'provisional title') }
  if (change.target === 'goal') return { ...current, goal: requiredText(change.proposed, 'goal') }
  if (change.target === 'root-focus') {
    return {
      ...current,
      focus: validateFocus({
        currentQuestion: change.proposed,
        level: change.focusLevel ?? current.focus.level,
        ...(change.returnTo === undefined ? {} : { returnTo: change.returnTo }),
      }),
    }
  }
  return current
}

function applyCaptures(
  current: readonly HumanFrame[],
  captures: readonly ResolvedCapture[],
  supersedeIds: readonly string[],
): { readonly frames: readonly HumanFrame[]; readonly addedCount: number; readonly added: readonly HumanFrame[] } {
  const superseded = new Set(supersedeIds.map(id => requiredText(id, 'superseded Human Frame id')))
  for (const id of superseded) {
    if (!current.some(frame => frame.id === id)) throw new Error(`Unknown Human Frame id ${id}.`)
  }
  const next = current.map(frame => superseded.has(frame.id) ? { ...frame, status: 'superseded' as const } : frame)
  const added: HumanFrame[] = []
  for (const capture of captures) {
    const quote = requiredText(capture.quote, 'capture quote')
    if (!Number.isSafeInteger(capture.eventSeq) || capture.eventSeq < 0) throw new Error('Capture eventSeq must be non-negative.')
    if (next.some(frame => frame.source.eventSeq === capture.eventSeq && frame.statement === quote && frame.kind === capture.kind)) continue
    const frame: HumanFrame = {
      id: `statement-${String(capture.eventSeq)}-${String(next.length + 1)}`,
      kind: capture.kind,
      statement: quote,
      ...(capture.normalizedRestatement === undefined ? {} : { normalizedRestatement: requiredText(capture.normalizedRestatement, 'normalized restatement') }),
      source: { eventSeq: capture.eventSeq, quote },
      status: 'active',
    }
    next.push(frame)
    added.push(frame)
  }
  return { frames: next, addedCount: added.length, added }
}

function installHumanMainline(
  current: Pick<DiscussionState, 'goal' | 'focus'>,
  added: readonly HumanFrame[],
): { readonly goal: string; readonly focus: DiscussionFocus } {
  let goal = current.goal
  let focus = current.focus
  for (const frame of added) {
    if (frame.kind === 'goal' && goal === NO_TOPIC_YET) {
      goal = frame.statement
    }
    if ((frame.kind === 'decision' || frame.kind === 'goal') && focus.currentQuestion === NO_TOPIC_YET) {
      focus = {
        currentQuestion: frame.statement,
        level: frame.kind === 'decision' ? 'decision' : focus.level,
        ...(focus.returnTo === undefined ? {} : { returnTo: focus.returnTo }),
      }
    }
  }
  return { goal, focus }
}

const ENGLISH_STOPWORDS = new Set([
  'about', 'after', 'again', 'being', 'below', 'between', 'could', 'doing',
  'during', 'other', 'ought', 'should', 'since', 'theirs', 'there', 'these',
  'those', 'through', 'under', 'until', 'where', 'which', 'while', 'would',
  'yours', 'their', 'itself', 'myself', 'because', 'before', 'having',
])

const CJK_STOPWORDS = new Set([
  '不是', '没有', '可以', '这个', '那个', '我们', '他们', '以及', '或者',
  '因为', '所以', '但是', '如果', '那么', '一个', '这些', '那些', '什么',
  '怎么', '如何', '自己', '进行', '通过', '对于', '关于', '作为', '已经',
  '还是', '只是', '就是', '而是',
])

function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    const word = match[0].toLowerCase()
    if (word.length >= 5 && !ENGLISH_STOPWORDS.has(word)) tokens.add(word)
  }
  const runs = text.match(/[\u3400-\u9FFF\uF900-\uFAFF]{2,}/g) ?? []
  for (const run of runs) {
    if (!CJK_STOPWORDS.has(run)) tokens.add(run)
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram)
    }
  }
  return tokens
}

function collidingLock(frames: readonly HumanFrame[], text: string): HumanFrame | undefined {
  for (const frame of frames) {
    if (frame.status !== 'active' || (frame.kind !== 'rejection' && frame.kind !== 'non-goal')) continue
    if (text.includes(frame.statement)) continue
    const locked = significantTokens(frame.statement)
    for (const token of significantTokens(text)) {
      if (locked.has(token)) return frame
    }
  }
  return undefined
}

function assertNoLockedContradiction(
  frames: readonly HumanFrame[],
  update: DiscussionUpdate,
  options: readonly DiscussionOption[],
  synthesis: DiscussionSynthesis,
): void {
  const texts: { readonly label: string; readonly value: string }[] = []
  if (update.synthesis?.recommendation !== undefined) {
    texts.push({ label: 'recommendation', value: synthesis.recommendation })
  }
  if (update.synthesis?.nextStep !== undefined) {
    texts.push({ label: 'next step', value: synthesis.nextStep })
  }
  for (const optionUpdate of update.optionUpdates ?? []) {
    const option = options.find(item => item.id === optionUpdate.id)
    if (option === undefined || option.status !== 'favored') continue
    texts.push({ label: 'favored option title', value: option.title })
    texts.push({ label: 'favored option id', value: option.id })
  }
  for (const item of texts) {
    const hit = collidingLock(frames, item.value)
    if (hit !== undefined) {
      throw new Error(`${item.label} collides with an active ${hit.kind}: “${hit.statement}”.`)
    }
  }
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
