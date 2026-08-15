import { describe, expect, it } from 'vitest'
import {
  acceptPendingFrameChange,
  activateDiscussion,
  applyDiscussionUpdate,
  assertDiscussionState,
  createDiscussionState,
  deactivateDiscussion,
  decodeDiscussionState,
  discussionRailRows,
  NO_TOPIC_YET,
  rejectPendingFrameChange,
  renderDiscussionMarkdown,
  renderDiscussionPolicy,
  UNTITLED_TITLE,
} from '../src/contract.ts'

function opened(intensity: 1 | 2 | 3 = 2) {
  return createDiscussionState({ id: 'discussion-world-model', intensity, now: 1 })
}

describe('portable Discussion state', () => {
  it('keeps /discussion untitled: intensity only, no inferred topic', () => {
    const state = opened()
    expect(state).toMatchObject({ active: true, intensity: 2, revision: 1 })
    expect(state.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(state.goal).toBe(NO_TOPIC_YET)
    expect(state.focus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(state.pendingFrameChanges).toEqual([])
    expect(renderDiscussionPolicy(state)).not.toContain('Infer the provisional topic')
    expect(renderDiscussionPolicy(state)).toContain('Do not invent or install a topic')
    expect(renderDiscussionMarkdown(state)).toMatch(/^# Untitled/u)
    expect(renderDiscussionMarkdown(state)).not.toContain('Topic to be distilled')
    expect(discussionRailRows(state)).toHaveLength(4)
    expect(discussionRailRows(state)[0]).toMatchObject({ label: 'Focus', value: NO_TOPIC_YET })
  })

  it('decodes version-1 sidecars that omit pendingFrameChanges as an empty list', () => {
    const raw = JSON.parse(JSON.stringify(opened())) as Record<string, unknown>
    delete raw.pendingFrameChanges
    const decoded = decodeDiscussionState(raw)
    expect(decoded.pendingFrameChanges).toEqual([])
    expect(decoded.version).toBe(1)
    expect(() => assertDiscussionState(raw)).toThrow('Pending Frame Changes must be an array.')
  })

  it('keeps exact direct-user wording separate from model normalization', () => {
    const next = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      captures: [{
        kind: 'constraint',
        quote: 'Occlusion is rare in the real setting; do not make it the main topic.',
        eventSeq: 7,
        normalizedRestatement: 'Treat occlusion only as an optional stress test.',
      }],
      historySummary: 'User removed occlusion from the project thesis.',
    }, 2)
    expect(next.humanFrame[0]).toMatchObject({
      statement: 'Occlusion is rare in the real setting; do not make it the main topic.',
      normalizedRestatement: 'Treat occlusion only as an optional stress test.',
      source: { eventSeq: 7, quote: 'Occlusion is rare in the real setting; do not make it the main topic.' },
    })
    expect(next.provisionalTitle).toBe(UNTITLED_TITLE)
    const forged = structuredClone(next) as unknown as {
      humanFrame: { statement: string }[]
    }
    forged.humanFrame[0]!.statement = 'Occlusion is the main topic.'
    expect(() => assertDiscussionState(forged)).toThrow('must equal source.quote')
  })

  it('turns a title write into a pending change and rejects a stale revision', () => {
    const state = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      provisionalTitle: 'OOD embodied experience generation',
    }, 2)
    expect(state.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(state.pendingFrameChanges).toMatchObject([{
      status: 'pending',
      target: 'title',
      proposed: 'OOD embodied experience generation',
    }])
    expect(() => applyDiscussionUpdate(state, {
      expectedRevision: 1,
      goal: 'This update observed stale context.',
    }, 3)).toThrow('expected 1, current 2')
  })

  it('retains WorldModel captures, evidence, and rejected options without silently installing a topic', () => {
    const corrected = applyDiscussionUpdate(opened(3), {
      expectedRevision: 1,
      provisionalTitle: 'Action-conditioned embodied World Model as a data engine',
      goal: 'Choose a novel, falsifiable direction that generates useful OOD robot experience.',
      captures: [
        {
          kind: 'goal',
          quote: 'The result must have real domain value and innovation.',
          eventSeq: 4,
        },
        {
          kind: 'constraint',
          quote: 'The World Model is an offline data engine, not the deployed policy.',
          eventSeq: 5,
        },
        {
          kind: 'preference',
          quote: 'Explain the direction in plain language before using specialist terms.',
          eventSeq: 6,
        },
        {
          kind: 'rejection',
          quote: 'Occlusion is rare in the real setting; do not make it the main topic.',
          eventSeq: 7,
          normalizedRestatement: 'Occlusion may be a stress test, never the thesis.',
        },
        {
          kind: 'criterion',
          quote: 'Evaluate both action precision and useful OOD experience.',
          eventSeq: 8,
        },
        {
          kind: 'decision',
          quote: 'The deliverables are a demo, a technical report, and a paper-ready experiment.',
          eventSeq: 9,
        },
      ],
      focus: {
        currentQuestion: 'Which expensive missing experience can a World Model generate reliably under OOD change?',
        level: 'direction',
        returnTo: 'Which research direction has both scientific novelty and data-engine value?',
      },
      optionUpdates: [
        {
          id: 'action-outcome',
          title: 'OOD action-outcome calibrated experience generation',
          evidenceFor: ['Action consequences are measurable and directly affect training data utility.'],
          evidenceAgainst: ['Requires paired or controllable outcome truth.'],
          status: 'favored',
        },
        {
          id: 'occlusion-memory',
          title: 'Occlusion-centric persistent memory',
          evidenceFor: ['Easy to demonstrate visually.'],
          evidenceAgainst: ['The user identified it as a rare, narrow setting.'],
          status: 'rejected',
        },
      ],
      synthesis: {
        interpretation: 'The project should optimize reliable OOD action consequences and downstream data utility, not a convenient visual corner case.',
        recommendation: 'Start from a strong open World Model and add calibrated action-outcome admission.',
        openPoint: 'Which public task family supplies paired outcome truth at useful scale?',
        nextStep: 'Compare the strongest existing bases and audit paired-truth availability.',
      },
      historySummary: 'Re-anchored the project away from occlusion and toward OOD data utility.',
    }, 10)
    expect(corrected.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(corrected.goal).toBe('The result must have real domain value and innovation.')
    expect(corrected.focus.currentQuestion).toBe('The result must have real domain value and innovation.')
    expect(corrected.focus.level).toBe('project')
    expect(corrected.pendingFrameChanges.map(change => change.target)).toEqual(['title', 'goal', 'root-focus'])
    expect(discussionRailRows(corrected).some(row => row.label === 'Pending')).toBe(true)

    const refined = applyDiscussionUpdate(corrected, {
      expectedRevision: 2,
      optionUpdates: [{
        id: 'action-outcome',
        evidenceFor: [
          'A fixed downstream learner can test whether generated experience is useful.',
        ],
      }],
      synthesis: {
        nextStep: 'Run the paired-truth feasibility gate before choosing architecture.',
      },
      historySummary: 'Made paired-truth feasibility the next decision gate.',
    }, 11)
    const correctedAgain = applyDiscussionUpdate(refined, {
      expectedRevision: 3,
      captures: [{
        kind: 'constraint',
        quote: 'Revisit and occlusion are optional stress tests, not the research thesis.',
        eventSeq: 12,
      }],
      supersedeStatementIds: [refined.humanFrame.find(frame => frame.source.eventSeq === 7)!.id],
      focus: {
        currentQuestion: 'How should the experiment plan test action precision and OOD usefulness?',
        level: 'experiment',
        returnTo: 'Which research direction has both scientific novelty and data-engine value?',
      },
      historySummary: 'Returned from wording work to the experiment plan and narrowed revisit/occlusion to stress tests.',
    }, 12)
    expect(correctedAgain.focus.currentQuestion).toBe('The result must have real domain value and innovation.')
    expect(correctedAgain.pendingFrameChanges.filter(change => change.status === 'pending' && change.target === 'root-focus')).toHaveLength(2)
    const resumed = activateDiscussion(deactivateDiscussion(correctedAgain, 13), {
      id: correctedAgain.id,
      intensity: correctedAgain.intensity,
      now: 14,
    })
    const replayed = decodeDiscussionState(JSON.parse(JSON.stringify(resumed)) as unknown)
    expect(replayed).toEqual(resumed)
    expect(replayed?.humanFrame.map(frame => frame.statement)).toEqual(expect.arrayContaining([
      'The result must have real domain value and innovation.',
      'The World Model is an offline data engine, not the deployed policy.',
      'Explain the direction in plain language before using specialist terms.',
      'Occlusion is rare in the real setting; do not make it the main topic.',
      'Evaluate both action precision and useful OOD experience.',
      'The deliverables are a demo, a technical report, and a paper-ready experiment.',
      'Revisit and occlusion are optional stress tests, not the research thesis.',
    ]))
    expect(replayed?.humanFrame.find(frame => frame.source.eventSeq === 7)?.status).toBe('superseded')
    expect(replayed?.options.find(option => option.id === 'occlusion-memory')?.status).toBe('rejected')
    expect(replayed?.options.find(option => option.id === 'action-outcome')?.evidenceFor).toEqual([
      'Action consequences are measurable and directly affect training data utility.',
      'A fixed downstream learner can test whether generated experience is useful.',
    ])
    expect(renderDiscussionPolicy(resumed)).toContain('Revisit and occlusion are optional stress tests, not the research thesis.')
    expect(renderDiscussionPolicy(resumed)).toContain('[decision]')
    expect(renderDiscussionPolicy(resumed)).toContain('especially rejection and decision frames')
    expect(renderDiscussionPolicy(resumed)).toContain('New papers, tool results, and research evidence stay candidates')
    expect(renderDiscussionMarkdown(resumed)).toContain('Run the paired-truth feasibility gate')
    expect(discussionRailRows(resumed).length).toBeGreaterThan(4)
  })

  it('applies a pending title only after accept, and keeps reject from rewriting the frame', () => {
    const proposed = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      provisionalTitle: 'Occlusion-centric World Model',
    }, 2)
    expect(proposed.provisionalTitle).toBe(UNTITLED_TITLE)
    const rejected = rejectPendingFrameChange(proposed, proposed.pendingFrameChanges[0]!.id, 3)
    expect(rejected.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(rejected.pendingFrameChanges[0]?.status).toBe('rejected')
    const accepted = acceptPendingFrameChange(proposed, proposed.pendingFrameChanges[0]!.id, 4)
    expect(accepted.provisionalTitle).toBe('Occlusion-centric World Model')
    expect(accepted.pendingFrameChanges[0]?.status).toBe('accepted')
  })

  it('pauses and resumes with the previous intensity unless the user selects another', () => {
    const paused = deactivateDiscussion(opened(3), 2)
    expect(paused.active).toBe(false)
    const resumed = activateDiscussion(paused, { id: paused.id, intensity: paused.intensity, now: 3 })
    expect(resumed).toMatchObject({ active: true, intensity: 3, revision: 3 })
    const fast = activateDiscussion(resumed, { id: resumed.id, intensity: 1, now: 4 })
    expect(fast).toMatchObject({ intensity: 1, revision: 4 })
  })

  it('gives the three intensity levels materially different behavior', () => {
    expect(renderDiscussionPolicy(opened(1))).toContain('FAST: stay concise')
    expect(renderDiscussionPolicy(opened(2))).toContain('DEFAULT: compare')
    expect(renderDiscussionPolicy(opened(3))).toContain('DEEP: reason from first principles')
    expect(renderDiscussionPolicy(opened(3))).toContain('strongest prior approach')
    expect(renderDiscussionPolicy(opened(3))).toContain('concrete difference')
    expect(renderDiscussionPolicy(opened(3))).toContain('falsifiable test')
    expect(renderDiscussionPolicy(opened(3))).toContain('field-level value')
  })
})
