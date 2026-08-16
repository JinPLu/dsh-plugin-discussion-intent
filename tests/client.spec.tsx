import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import {
  applyDiscussionUpdate,
  createDiscussionState,
  formatSubagentRailStatus,
  unsetSubagentRailStatus,
  type DiscussionState,
} from '../src/contract.ts'
import {
  applyLivePayload,
  applyStateFallback,
  classifyLivePayload,
  decodeLiveState,
  discussionIntentStatePath,
  compactRailText,
  DiscussionRail,
  formatLocalizedSubagentRailStatus,
  HIDE_GOAL_BAR_CSS,
  railHeaderNarrative,
  railValueStyle,
  toggleExpandedRailRow,
  visibleLiveState,
  type LiveDiscussionSnapshot,
} from '../src/client/index.tsx'

const t = (key: string) => ({
  headerTitle: 'In discussion',
  noFocus: 'No working focus yet',
  saved: 'saved',
  unsaved: 'not saved',
  Pending: 'Pending',
  subagentLabel: 'subagent',
  subagentRunning: 'running',
  subagentUnset: 'unset',
}[key] ?? key)

function findByData(node: unknown, attr: string): ReactElement | undefined {
  if (typeof node !== 'object' || node === null || !('props' in node)) return undefined
  const el = node as ReactElement
  if (el.props[attr] !== undefined) return el
  const children = el.props.children
  const list = Array.isArray(children) ? children.flat() : children === undefined || children === false ? [] : [children]
  for (const child of list) {
    const found = findByData(child, attr)
    if (found) return found
  }
  return undefined
}

function headerText(element: ReactElement, attr: string): string | undefined {
  const found = findByData(element, attr)
  return found === undefined ? undefined : found.props.children as string
}

function renderRowCount(element: ReactElement | null): number {
  expect(element).not.toBeNull()
  const aside = element!.props.children as ReactElement
  expect(aside.type).toBe('aside')
  return (aside.props.children as readonly unknown[]).flat().filter(child =>
    typeof child === 'object' && child !== null && 'type' in child && (child as ReactElement).type === 'section',
  ).length
}

function railSections(element: ReactElement): ReactElement[] {
  const aside = element.props.children as ReactElement
  return (aside.props.children as readonly unknown[]).flat().filter(child =>
    typeof child === 'object' && child !== null && 'type' in child && (child as ReactElement).type === 'section',
  ) as ReactElement[]
}

function rowValue(row: ReactElement): string {
  return (row.props.children as ReactElement[])[1]!.props.children as string
}

function rowValueStyle(row: ReactElement): Record<string, unknown> {
  return (row.props.children as ReactElement[])[1]!.props.style as Record<string, unknown>
}

function findRow(element: ReactElement, label: string): ReactElement {
  return railSections(element).find(row => row.props['aria-label'] === label)!
}

describe('Discussion Rail', () => {
  it('stays hidden without an active Discussion state', () => {
    expect(DiscussionRail({ state: undefined, t })).toBeNull()
    expect(DiscussionRail({ state: null, t })).toBeNull()
    expect(DiscussionRail({ state: { active: false } as DiscussionState, t })).toBeNull()
  })

  it('stays collapsed to the header by default and opens the four rows on demand', () => {
    const state = createDiscussionState({ id: 'rail-render', intensity: 3, now: 1 })
    const collapsed = DiscussionRail({ state, t })!
    expect(collapsed.type).toBe('div')
    expect(collapsed.props['data-discussion-rail-open']).toBe('false')
    expect(renderRowCount(collapsed)).toBe(0)
    expect(headerText(collapsed, 'data-discussion-header-title')).toBe('In discussion')
    expect(headerText(collapsed, 'data-discussion-header-focus')).toBe('No working focus yet')
    expect(headerText(collapsed, 'data-discussion-intensity')).toBe('deep')
    expect(headerText(collapsed, 'data-discussion-subagent')).toBeUndefined()
    expect(findByData(collapsed, 'data-discussion-hide-goal')?.props.children).toBe(HIDE_GOAL_BAR_CSS)
    expect(findByData(collapsed, 'data-discussion-checkpoint')?.props['aria-label']).toBe('not saved')
    expect(findByData(collapsed, 'data-discussion-checkpoint')?.props['data-discussion-checkpoint-status']).toBe('unsaved')
    expect(railHeaderNarrative(state, 'No working focus yet')).toEqual({
      full: 'No working focus yet',
      display: 'No working focus yet',
      empty: true,
    })

    const toggles: number[] = []
    const clickable = DiscussionRail({
      state,
      t,
      onToggleOpen: () => { toggles.push(1) },
    })!
    findByData(clickable, 'data-discussion-intent-header')!.props.onClick()
    expect(toggles).toEqual([1])

    const opened = DiscussionRail({ state, t, open: true })!
    expect(opened.props['data-discussion-rail-open']).toBe('true')
    expect(renderRowCount(opened)).toBe(4)
    const firstRow = railSections(opened)[0]!
    expect(firstRow.props['aria-label']).toBe('Focus')
    const values = railSections(opened).map(rowValue)
    expect(values[0]).toBe('No topic yet.')
    expect(values).not.toContain('Topic to be distilled')
  })

  it('uses the working focus as the header sentence, not Discussion · 3=deep', () => {
    const locked = applyDiscussionUpdate(createDiscussionState({ id: 'rail-header', intensity: 3, now: 1 }), {
      expectedRevision: 1,
      captures: [{ kind: 'decision', quote: '先把论文主线收敛到可执行计划。', eventSeq: 4 }],
    }, 2)
    const dived = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      focus: {
        currentQuestion: 'VLM 能否重读自己输出的 ViT embedding？',
        level: 'mechanism',
        returnTo: '先把论文主线收敛到可执行计划。',
      },
    }, 3)
    const element = DiscussionRail({ state: dived, t })!
    expect(renderRowCount(element)).toBe(0)
    expect(headerText(element, 'data-discussion-header-title')).toBe('In discussion')
    expect(headerText(element, 'data-discussion-header-focus')).toBe(
      'VLM 能否重读自己输出的 ViT embedding？ · ↑先把论文主线收敛到可执行计划。',
    )
    expect(headerText(element, 'data-discussion-intensity')).toBe('deep')
    expect(String(headerText(element, 'data-discussion-header-focus'))).not.toContain('3=deep')
    const long = `${'焦点'.repeat(80)}还要更长`
    expect(compactRailText(long).length).toBeLessThanOrEqual(120)
    expect(compactRailText(long).endsWith('…')).toBe(true)
  })

  it('shows configured subagent model and effort in the header, not under Next', () => {
    const state = createDiscussionState({ id: 'rail-subagent', intensity: 2, now: 1 })
    const subagent = { provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high', phase: 'next' as const }
    const element = DiscussionRail({ state, subagent, t, open: true })!
    expect(renderRowCount(element)).toBe(4)
    expect(headerText(element, 'data-discussion-intensity')).toBe('default')
    expect(headerText(element, 'data-discussion-subagent')).toBe('v4-flash · high')
    const next = railSections(element).find(row => row.props['aria-label'] === 'Next')!
    expect(rowValue(next)).not.toContain('v4-flash')
    expect(findByData(next, 'data-discussion-subagent')).toBeUndefined()
    expect(formatLocalizedSubagentRailStatus(subagent, t)).toBe('v4-flash · high')
    expect(formatSubagentRailStatus(unsetSubagentRailStatus())).toBe('subagent unset')
  })

  it('qualifies a live child as running in the header', () => {
    const state = createDiscussionState({ id: 'rail-running', intensity: 3, now: 1 })
    const element = DiscussionRail({
      state,
      subagent: { model: 'deepseek-v4-pro', effort: 'max', phase: 'running' },
      t,
      open: true,
    })!
    expect(renderRowCount(element)).toBe(4)
    expect(headerText(element, 'data-discussion-subagent')).toBe('running · v4-pro · max')
    const next = railSections(element).find(row => row.props['aria-label'] === 'Next')!
    expect(findByData(next, 'data-discussion-subagent')).toBeUndefined()
  })

  it('shows working focus and the locked root in the same Focus cell', () => {
    const locked = applyDiscussionUpdate(createDiscussionState({ id: 'rail-root', intensity: 2, now: 1 }), {
      expectedRevision: 1,
      captures: [{ kind: 'decision', quote: '先把论文主线收敛到可执行计划。', eventSeq: 4 }],
    }, 2)
    const dived = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      focus: {
        currentQuestion: 'VLM 能否重读自己输出的 ViT embedding？',
        level: 'mechanism',
        returnTo: '先把论文主线收敛到可执行计划。',
      },
    }, 3)
    const element = DiscussionRail({ state: dived, t, open: true })!
    const focus = railSections(element).find(row => row.props['aria-label'] === 'Focus')!
    expect(rowValue(focus)).toBe('VLM 能否重读自己输出的 ViT embedding？ · ↑先把论文主线收敛到可执行计划。')
    const valueNode = (focus.props.children as ReactElement[])[1]
    expect(valueNode?.props.title).toBe('VLM 能否重读自己输出的 ViT embedding？ · ↑先把论文主线收敛到可执行计划。')
  })

  it('surfaces pending frame changes so accept/reject is visible without reading the log', () => {
    const proposed = applyDiscussionUpdate(createDiscussionState({ id: 'rail-pending', intensity: 2, now: 1 }), {
      expectedRevision: 1,
      provisionalTitle: 'A proposed topic',
    }, 2)
    const element = DiscussionRail({
      state: proposed,
      subagent: unsetSubagentRailStatus(),
      t,
      open: true,
    })!
    expect(renderRowCount(element)).toBe(5)
    expect(headerText(element, 'data-discussion-pending-count')).toBe('Pending 1')
    const pending = railSections(element).find(row => row.props['aria-label'] === 'Pending')
    expect(pending).toBeDefined()
    expect(rowValue(pending!)).toContain('/discussion accept')
    expect(rowValue(pending!)).toContain('/discussion reject')
    expect(headerText(element, 'data-discussion-subagent')).toBe('subagent unset')
    const next = railSections(element).find(row => row.props['aria-label'] === 'Next')!
    expect(findByData(next, 'data-discussion-subagent')).toBeUndefined()
  })

  it('clamps values to two lines by default and expands only the clicked row', () => {
    const state = createDiscussionState({ id: 'rail-clamp', intensity: 2, now: 1 })
    const collapsed = DiscussionRail({ state, t, open: true })!
    const focus = findRow(collapsed, 'Focus')
    const you = findRow(collapsed, 'You')
    expect(focus.props['data-expanded']).toBe('false')
    expect(rowValueStyle(focus).WebkitLineClamp).toBe(2)
    expect(rowValueStyle(focus).whiteSpace).not.toBe('nowrap')
    expect(railValueStyle(false, 'human').WebkitLineClamp).toBe(2)
    expect(toggleExpandedRailRow(undefined, 'Focus')).toBe('Focus')
    expect(toggleExpandedRailRow('Focus', 'Focus')).toBeUndefined()
    expect(toggleExpandedRailRow('Focus', 'You')).toBe('You')

    const expandedFocus = DiscussionRail({ state, t, open: true, expandedLabel: 'Focus' })!
    expect(findRow(expandedFocus, 'Focus').props['data-expanded']).toBe('true')
    expect(rowValueStyle(findRow(expandedFocus, 'Focus')).WebkitLineClamp).toBe('unset')
    expect(findRow(expandedFocus, 'You').props['data-expanded']).toBe('false')
    expect(rowValueStyle(findRow(expandedFocus, 'You')).WebkitLineClamp).toBe(2)

    const expandedYou = DiscussionRail({ state, t, open: true, expandedLabel: 'You' })!
    expect(findRow(expandedYou, 'Focus').props['data-expanded']).toBe('false')
    expect(findRow(expandedYou, 'You').props['data-expanded']).toBe('true')
    expect(rowValueStyle(findRow(expandedYou, 'You')).WebkitLineClamp).toBe('unset')
    expect(you.props.onClick).toBeUndefined()
  })

  it('lets a Pending row expand without becoming click-to-accept', () => {
    const proposed = applyDiscussionUpdate(createDiscussionState({ id: 'rail-pending-expand', intensity: 2, now: 1 }), {
      expectedRevision: 1,
      provisionalTitle: 'A proposed topic',
    }, 2)
    const clicks: string[] = []
    const element = DiscussionRail({
      state: proposed,
      t,
      open: true,
      expandedLabel: 'Pending',
      onToggleRow: label => { clicks.push(label) },
    })!
    const pending = findRow(element, 'Pending')
    expect(pending.props['data-expanded']).toBe('true')
    expect(rowValue(pending)).toContain('/discussion accept')
    expect(rowValueStyle(pending).WebkitLineClamp).toBe('unset')
    pending.props.onClick()
    expect(clicks).toEqual(['Pending'])
    expect(rowValue(pending)).toContain('/discussion reject')
  })

  it('opens the same catalog picker from an unset or selected chip, but not while running', () => {
    const state = createDiscussionState({ id: 'rail-picker', intensity: 2, now: 1 })
    const catalog = [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ]
    const picked: { provider: string; model: string }[] = []
    const unset = DiscussionRail({
      state,
      subagent: unsetSubagentRailStatus(),
      t,
      pickerOpen: true,
      catalog,
      onTogglePicker: () => undefined,
      onPickSubagent: route => { picked.push(route) },
    })!
    const unsetChip = findByData(unset, 'data-discussion-subagent')!
    expect(unsetChip.props.role).toBe('button')
    expect(unsetChip.props.onClick).toBeTypeOf('function')
    const picker = findByData(unset, 'data-discussion-subagent-picker')
    expect(picker).toBeDefined()
    expect((picker!.props.style as { position?: string }).position).toBe('absolute')
    const opens: number[] = []
    const chipOnly = DiscussionRail({
      state,
      subagent: unsetSubagentRailStatus(),
      t,
      onToggleOpen: () => { opens.push(1) },
      onTogglePicker: () => undefined,
    })!
    findByData(chipOnly, 'data-discussion-subagent')!.props.onClick({ stopPropagation() { /* chip */ } })
    expect(opens).toEqual([])
    expect(chipOnly.props['data-discussion-rail-open']).toBe('false')
    expect(formatLocalizedSubagentRailStatus({
      model: 'gpt-5.6-luna',
      effort: 'default',
      phase: 'next',
    }, t)).toBe('gpt-5.6-luna')
    const options = (picker!.props.children as ReactElement[])
    expect(options).toHaveLength(2)
    expect(options[0]?.props['data-discussion-subagent-option']).toBe('deepseek-official/deepseek-v4-flash')
    options[1]!.props.onClick({ stopPropagation() { /* picker click */ } })
    expect(picked).toEqual([{ provider: 'openai-codex', model: 'gpt-5.6-sol' }])

    const selected = DiscussionRail({
      state,
      subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high', phase: 'next' },
      t,
      pickerOpen: true,
      catalog,
      onTogglePicker: () => undefined,
    })!
    expect(findByData(selected, 'data-discussion-subagent')?.props.role).toBe('button')
    expect(findByData(selected, 'data-discussion-subagent-picker')).toBeDefined()

    const running = DiscussionRail({
      state,
      subagent: { model: 'deepseek-v4-pro', effort: 'max', phase: 'running' },
      t,
      pickerOpen: true,
      catalog,
      onTogglePicker: () => undefined,
    })!
    const runningChip = findByData(running, 'data-discussion-subagent')!
    expect(runningChip.props.role).toBeUndefined()
    expect(runningChip.props.onClick).toBeUndefined()
    expect(runningChip.props['data-discussion-subagent-phase']).toBe('running')
  })
})

describe('decodeLiveState', () => {
  it('accepts a whole state and rejects the inactive shorthand, garbage, and malformed payloads', () => {
    const state = createDiscussionState({ id: 'wire', intensity: 1, now: 1 })
    expect(decodeLiveState(JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state)
    expect(decodeLiveState({ active: false })).toBeUndefined()
    expect(decodeLiveState({ active: true })).toBeUndefined()
    expect(decodeLiveState({ active: true, revision: 'many' })).toBeUndefined()
    expect(decodeLiveState(null)).toBeUndefined()
    expect(decodeLiveState('nope')).toBeUndefined()
    expect(decodeLiveState(42)).toBeUndefined()
  })

  it('keeps the newest revision when payloads arrive out of order', () => {
    const newest = createDiscussionState({ id: 'guard', intensity: 2, now: 1 })
    const olderWire = JSON.parse(JSON.stringify(newest)) as DiscussionState
    const older = { ...olderWire, revision: olderWire.revision - 1 } as DiscussionState
    let shown: DiscussionState | undefined
    let snapshot: LiveDiscussionSnapshot = { sessionId: 'guard' }
    for (const payload of [older, JSON.parse(JSON.stringify(newest)) as DiscussionState]) {
      snapshot = applyLivePayload(snapshot, 'guard', payload)
      shown = snapshot.state
    }
    expect(shown).toEqual(newest)
  })
})

describe('classifyLivePayload and live reducers', () => {
  it('distinguishes inactive shorthand from decode failure', () => {
    const state = createDiscussionState({ id: 'classify', intensity: 2, now: 1 })
    expect(classifyLivePayload({ active: false })).toEqual({ kind: 'inactive' })
    expect(classifyLivePayload({ active: true, revision: 1 })).toEqual({ kind: 'invalid' })
    expect(classifyLivePayload({ ...JSON.parse(JSON.stringify(state)), goal: '' })).toEqual({ kind: 'invalid' })
    expect(classifyLivePayload(JSON.parse(JSON.stringify(state)))).toEqual({ kind: 'state', state })
    const withOverlay = {
      ...JSON.parse(JSON.stringify(state)) as DiscussionState,
      subagent: { model: 'deepseek-v4-flash', effort: 'high', phase: 'next' },
    }
    expect(classifyLivePayload(withOverlay)).toEqual({
      kind: 'state',
      state,
      subagent: { model: 'deepseek-v4-flash', effort: 'high', phase: 'next' },
    })
    expect(decodeLiveState(withOverlay)).toEqual(state)
    expect(classifyLivePayload({
      ...JSON.parse(JSON.stringify(state)) as DiscussionState,
      subagent: { model: 'deepseek-v4-flash' },
    })).toEqual({ kind: 'state', state })
  })

  it('keeps the previous frame when a payload fails to decode', () => {
    const state = createDiscussionState({ id: 'keep-last', intensity: 3, now: 1 })
    const current = { sessionId: 'keep-last', state }
    expect(applyLivePayload(current, 'keep-last', { active: true, revision: 9 })).toEqual(current)
    expect(applyLivePayload(current, 'keep-last', { ...JSON.parse(JSON.stringify(state)), goal: '' })).toEqual(current)
    expect(applyLivePayload(current, 'keep-last', { active: false })).toEqual({ sessionId: 'keep-last' })
    const withOverlay = {
      sessionId: 'keep-last',
      state,
      subagent: { model: 'deepseek-v4-flash', effort: 'high', phase: 'next' as const },
    }
    expect(applyLivePayload(withOverlay, 'keep-last', { active: true, revision: 9 })).toEqual(withOverlay)
  })

  it('uses GET /state only as a seed fallback and never wipes a live frame', () => {
    const state = createDiscussionState({ id: 'fallback', intensity: 2, now: 1 })
    const empty = { sessionId: 'fallback' }
    const live = { sessionId: 'fallback', state }
    expect(discussionIntentStatePath('fallback')).toBe('/dsh/discussion-intent/state?sessionId=fallback')
    expect(applyStateFallback(empty, 'fallback', JSON.parse(JSON.stringify(state)))).toEqual(live)
    expect(applyStateFallback(live, 'fallback', { active: false })).toEqual(live)
    expect(applyStateFallback(live, 'fallback', { active: true, revision: 1 })).toEqual(live)
    expect(applyStateFallback(empty, 'fallback', { active: false })).toEqual(empty)
  })
})

describe('visibleLiveState', () => {
  it('hides the previous snapshot immediately when the selected session changes', () => {
    const fromA = createDiscussionState({ id: 'session-a', intensity: 3, now: 1 })
    const snapshot = { sessionId: 'session-a', state: fromA }
    expect(visibleLiveState(snapshot, 'session-a')).toBe(fromA)
    expect(visibleLiveState(snapshot, 'session-b')).toBeUndefined()
    expect(visibleLiveState(snapshot, undefined)).toBeUndefined()
  })
})
