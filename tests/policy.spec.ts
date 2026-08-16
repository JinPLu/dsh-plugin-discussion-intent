import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyDiscussionUpdate,
  createDiscussionState,
  discussionRailRows,
  renderDiscussionMarkdown,
  renderDiscussionPolicy,
} from '../src/contract.ts'

const adapterSource = readFileSync(fileURLToPath(new URL('../src/dsh-adapter.ts', import.meta.url)), 'utf8')

function policy(intensity: 1 | 2 | 3 = 2): string {
  return renderDiscussionPolicy(createDiscussionState({ id: 'policy', intensity, now: 1 }))
}

describe('Collaborate discussion policy', () => {
  it('requires stage map, batch asks, option stakes, explain-before-ask, recommend, and turn close', () => {
    const fast = policy(1)
    const standard = policy(2)
    const deep = policy(3)
    expect(fast).toContain('Avoid asking')
    expect(standard).toContain('at most one batch')
    expect(deep).toContain('Batch every independent valuable question')
    for (const text of [fast, standard, deep]) {
      expect(text).toContain('Stage · settled · open forks')
      expect(text).toContain('Focus / rootFocus')
      expect(text).toContain('benefit / cost / assumption / consequence')
      expect(text).toContain('Explain before ask')
      expect(text).toContain('(Recommended)')
      expect(text).toContain('closed stage and the opened stage')
      expect(text).toContain('recommendation / openPoint / nextStep')
      expect(text).toContain('authorized action')
      expect(text).toContain('visible prose → discussion_update → then ask_user_question')
      expect(text).toContain('Facts that can be looked up must be looked up')
      expect(text).not.toContain('Ask one question at a time')
    }
  })

  it('requires pending-first confirmation and subagent handoff without a fake contributeRun gate', () => {
    const text = policy(2)
    expect(text).toContain('Pending first')
    expect(text).toContain('do not ask other preference questions first')
    expect(text).toContain('question and impact')
    expect(text).toContain('accept/reject')
    expect(text).toContain('must not auto-lock the root')
    expect(text).toContain('objective, scope, settled constraints, evidence, requested return')
    expect(text).toContain('must not block the main discussion')
    expect(text).toContain('before spawning a subagent')
    expect(text).toContain('after each bounded return')
    expect(text).toContain('no contributeRun')
    expect(text).toContain('prompt only')
    expect(text).toContain('Do not invent a Writer')
    expect(text).not.toContain('docs/teamwork/discussions/')
  })

  it('keeps discussion_update tool docs aligned with the same cadence', () => {
    expect(adapterSource).toContain('benefit, cost, assumption, and consequence')
    expect(adapterSource).toContain('Do not add new option fields')
    expect(adapterSource).toContain('(Recommended)')
    expect(adapterSource).toContain('closed stage and the opened stage')
    expect(adapterSource).toContain('visible prose → discussion_update → then ask_user_question')
    expect(adapterSource).toContain('before spawning a subagent')
    expect(adapterSource).toContain('after each bounded return')
    expect(adapterSource).not.toContain('Ask one question at a time')
  })

  it('marks the first favored option as Recommended in sidecar markdown', () => {
    const state = applyDiscussionUpdate(createDiscussionState({ id: 'recommended', intensity: 2, now: 1 }), {
      expectedRevision: 1,
      optionUpdates: [
        {
          id: 'keep',
          title: 'Keep the current direction',
          evidenceFor: ['Benefit: preserves settled constraints.'],
          evidenceAgainst: ['Cost: slower exploration.'],
          status: 'favored',
        },
        {
          id: 'reopen',
          title: 'Reopen the root',
          evidenceFor: ['Assumption: the root is still empty.'],
          evidenceAgainst: ['Consequence: would require accept.'],
          status: 'open',
        },
      ],
      synthesis: {
        recommendation: 'Keep the current direction.',
        openPoint: 'Whether to accept the pending title.',
        nextStep: 'Use /discussion accept after the pending batch.',
      },
      historySummary: 'Closed direction comparison and opened pending confirmation.',
    }, 2)
    const markdown = renderDiscussionMarkdown(state)
    expect(markdown).toContain('## Current stage')
    expect(markdown).toContain('## Current question batch')
    expect(markdown).toContain('Whether to accept the pending title.')
    expect(markdown).toContain('## Options and recommendation')
    expect(markdown).toContain('keep: Keep the current direction (Recommended)')
    expect(markdown).toContain('## Decisions and open points')
    expect(markdown).toContain('Next authorized action: Use /discussion accept after the pending batch.')
    expect(Object.keys(state.options[0]!).sort()).toEqual([
      'evidenceAgainst',
      'evidenceFor',
      'id',
      'status',
      'title',
    ])
    expect(discussionRailRows(state)).toHaveLength(4)
  })
})
