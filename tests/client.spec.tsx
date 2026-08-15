import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { createDiscussionState, type DiscussionState } from '../src/contract.ts'
import { DiscussionRail, decodeLiveState, visibleLiveState } from '../src/client/index.tsx'

const t = (key: string) => key

function renderRowCount(element: ReactElement | null): number {
  expect(element).not.toBeNull()
  const aside = element!.props.children as ReactElement
  expect(aside.type).toBe('aside')
  return (aside.props.children as readonly unknown[]).flat().filter(child =>
    typeof child === 'object' && child !== null && 'type' in child && (child as ReactElement).type === 'section',
  ).length
}

describe('Discussion Rail', () => {
  it('stays hidden without an active Discussion state', () => {
    expect(DiscussionRail({ state: undefined, t })).toBeNull()
    expect(DiscussionRail({ state: null, t })).toBeNull()
    expect(DiscussionRail({ state: { active: false } as DiscussionState, t })).toBeNull()
  })

  it('renders exactly four read-only rows with intensity and save status', () => {
    const state = createDiscussionState({ id: 'rail-render', intensity: 3, now: 1 })
    const element = DiscussionRail({ state, t })!
    expect(element.type).toBe('div')
    const aside = element.props.children as ReactElement
    expect(aside.props['aria-label']).toBe('title')
    const header = (aside.props.children as ReactElement[])[0] as ReactElement
    expect(header.type).toBe('div')
    expect(renderRowCount(element)).toBe(4)
    const flattened = (aside.props.children as readonly unknown[]).flat() as ReactElement[]
    const firstRow = flattened.find(child => child.type === 'section')!
    expect(firstRow.props['aria-label']).toBe('Focus')
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
    let latestRevision = Number.NEGATIVE_INFINITY
    let shown: DiscussionState | undefined
    for (const payload of [older, JSON.parse(JSON.stringify(newest)) as DiscussionState]) {
      const decoded = decodeLiveState(payload)
      if (decoded !== undefined && decoded.revision >= latestRevision) {
        latestRevision = decoded.revision
        shown = decoded
      }
    }
    expect(shown).toEqual(newest)
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
