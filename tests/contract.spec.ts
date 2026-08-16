import { describe, expect, it } from 'vitest'
import {
  acceptPendingFrameChange,
  activateDiscussion,
  applyDiscussionUpdate,
  assertDiscussionState,
  createDiscussionState,
  deactivateDiscussion,
  decodeDiscussionState,
  decodeSubagentRailStatus,
  discussionRailRows,
  formatSubagentRailStatus,
  shortSubagentModel,
  NO_TOPIC_YET,
  rejectPendingFrameChange,
  renderDiscussionMarkdown,
  renderDiscussionPolicy,
  unsetSubagentRailStatus,
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
    expect(state.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
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

  it('decodes version-1 sidecars that omit rootFocus by copying the locked working focus', () => {
    const raw = JSON.parse(JSON.stringify(opened())) as Record<string, unknown>
    raw.focus = { currentQuestion: 'Which missing experience should the World Model generate?', level: 'direction' }
    delete raw.rootFocus
    const decoded = decodeDiscussionState(raw)
    expect(decoded.rootFocus).toEqual(decoded.focus)
    expect(decoded.rootFocus.currentQuestion).toBe('Which missing experience should the World Model generate?')
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
    expect(corrected.rootFocus.currentQuestion).toBe('The deliverables are a demo, a technical report, and a paper-ready experiment.')
    expect(corrected.focus.currentQuestion).toBe('The deliverables are a demo, a technical report, and a paper-ready experiment.')
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
    expect(correctedAgain.focus.currentQuestion).toBe('The deliverables are a demo, a technical report, and a paper-ready experiment.')
    expect(correctedAgain.rootFocus.currentQuestion).toBe('The deliverables are a demo, a technical report, and a paper-ready experiment.')
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
    expect(renderDiscussionPolicy(opened(1))).toContain('Avoid asking')
    expect(renderDiscussionPolicy(opened(2))).toContain('DEFAULT: compare')
    expect(renderDiscussionPolicy(opened(2))).toContain('at most one batch')
    expect(renderDiscussionPolicy(opened(3))).toContain('DEEP: reason from first principles')
    expect(renderDiscussionPolicy(opened(3))).toContain('strongest prior approach')
    expect(renderDiscussionPolicy(opened(3))).toContain('concrete difference')
    expect(renderDiscussionPolicy(opened(3))).toContain('falsifiable test')
    expect(renderDiscussionPolicy(opened(3))).toContain('field-level value')
    expect(renderDiscussionPolicy(opened(3))).toContain('Batch every independent valuable question')
  })

  it('renders Collaborate sidecar sections from existing fields only', () => {
    const markdown = renderDiscussionMarkdown(opened())
    expect(markdown).toContain('## Current stage')
    expect(markdown).toContain('## Current question batch')
    expect(markdown).toContain('## Options and recommendation')
    expect(markdown).toContain('## Decisions and open points')
    expect(markdown).toContain(`- Focus (project): ${NO_TOPIC_YET}`)
    expect(markdown).toContain(`- Root focus (project): ${NO_TOPIC_YET}`)
    expect(markdown).toContain(NO_TOPIC_YET)
    expect(markdown).toContain('Next authorized action:')
    expect(markdown).not.toContain('assumption:')
    expect(markdown).not.toContain('docs/teamwork/discussions/')
  })

  it('installs only working focus from the opening user message', () => {
    const next = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      captures: [{
        kind: 'goal',
        quote: '查看 Codex 线程并继续讨论论文主线。',
        eventSeq: 9,
      }],
    }, 2, 9)
    expect(next.goal).toBe(NO_TOPIC_YET)
    expect(next.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(next.focus.currentQuestion).toBe('查看 Codex 线程并继续讨论论文主线。')
    expect(discussionRailRows(next)[0]).toMatchObject({ label: 'Focus', value: '查看 Codex 线程并继续讨论论文主线。' })
  })

  it('dives working focus immediately when returnTo names the locked root at a deeper level', () => {
    const locked = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      captures: [{
        kind: 'decision',
        quote: '先把论文主线收敛到可执行计划。',
        eventSeq: 4,
      }],
    }, 2)
    expect(locked.rootFocus.currentQuestion).toBe('先把论文主线收敛到可执行计划。')
    const dived = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      focus: {
        currentQuestion: 'VLM 能否重读自己输出的 ViT embedding 并在渲染前自修？',
        level: 'mechanism',
        returnTo: '先把论文主线收敛到可执行计划。',
      },
      historySummary: 'Sank working focus to the Bernini self-read question.',
    }, 3)
    expect(dived.focus.currentQuestion).toBe('VLM 能否重读自己输出的 ViT embedding 并在渲染前自修？')
    expect(dived.rootFocus.currentQuestion).toBe('先把论文主线收敛到可执行计划。')
    expect(dived.pendingFrameChanges.filter(change => change.target === 'root-focus')).toEqual([])
    expect(discussionRailRows(dived)[0]?.value).toBe(
      'VLM 能否重读自己输出的 ViT embedding 并在渲染前自修？ · ↑先把论文主线收敛到可执行计划。',
    )
  })

  it('keeps a focus write without returnTo as a pending root change', () => {
    const locked = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      captures: [{
        kind: 'decision',
        quote: '先把论文主线收敛到可执行计划。',
        eventSeq: 4,
      }],
    }, 2)
    const proposed = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      focus: {
        currentQuestion: 'How should occlusion become the root experiment?',
        level: 'direction',
      },
    }, 3)
    expect(proposed.focus.currentQuestion).toBe('先把论文主线收敛到可执行计划。')
    expect(proposed.rootFocus.currentQuestion).toBe('先把论文主线收敛到可执行计划。')
    expect(proposed.pendingFrameChanges).toMatchObject([{
      status: 'pending',
      target: 'root-focus',
      proposed: 'How should occlusion become the root experiment?',
    }])
  })

  it('captures an ask_user_question label as You without locking the root', () => {
    const openedFocus = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      captures: [{
        kind: 'criterion',
        quote: 'Action precision is a capability gate; OOD is the core evaluation axis.',
        eventSeq: 3,
      }],
    }, 2, 3)
    const answered = applyDiscussionUpdate(openedFocus, {
      expectedRevision: 2,
      captures: [{
        kind: 'decision',
        quote: '接受 D：给定 W，只学习显式电影决策 C 与连续执行计划 Z。',
        eventSeq: 40,
        origin: 'ask_user_question',
      }],
    }, 3, 3)
    expect(answered.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(answered.focus.currentQuestion).toBe('接受 D：给定 W，只学习显式电影决策 C 与连续执行计划 Z。')
    const you = discussionRailRows(answered).find(row => row.label === 'You')?.value
    expect(you).toContain('接受 D：给定 W，只学习显式电影决策 C 与连续执行计划 Z。')
    expect(you).toContain('Action precision is a capability gate; OOD is the core evaluation axis.')
  })

  it('does not treat process or refresh quotes as You locks or focus moves', () => {
    const started = applyDiscussionUpdate(opened(), {
      expectedRevision: 1,
      captures: [{
        kind: 'decision',
        quote: '先把论文主线收敛到可执行计划。',
        eventSeq: 4,
      }],
    }, 2)
    const refreshed = applyDiscussionUpdate(started, {
      expectedRevision: 2,
      captures: [
        { kind: 'decision', quote: 'spawn subagents', eventSeq: 5 },
        { kind: 'criterion', quote: '更新当前的讨论情况。包括焦点，我说过的点、当前理解、下一步等', eventSeq: 6 },
      ],
    }, 3)
    expect(refreshed.focus.currentQuestion).toBe('先把论文主线收敛到可执行计划。')
    expect(refreshed.rootFocus.currentQuestion).toBe('先把论文主线收敛到可执行计划。')
    const you = discussionRailRows(refreshed).find(row => row.label === 'You')?.value
    expect(you).toContain('先把论文主线收敛到可执行计划。')
    expect(you).not.toContain('spawn subagents')
    expect(you).not.toContain('更新当前的讨论情况')
  })
})

describe('subagent Rail overlay', () => {
  it('formats configured and running status without adding a Rail row', () => {
    expect(formatSubagentRailStatus(unsetSubagentRailStatus())).toBe('subagent unset')
    expect(formatSubagentRailStatus({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      effort: 'high',
      phase: 'next',
    })).toBe('v4-flash · high')
    expect(formatSubagentRailStatus({
      model: 'deepseek-v4-pro',
      effort: 'max',
      phase: 'running',
    })).toBe('running · v4-pro · max')
    expect(shortSubagentModel('deepseek-v4-flash')).toBe('v4-flash')
    expect(shortSubagentModel('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(discussionRailRows(opened())).toHaveLength(4)
  })

  it('decodes a valid overlay and ignores a malformed one', () => {
    expect(decodeSubagentRailStatus({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      effort: 'high',
      phase: 'next',
    })).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      effort: 'high',
      phase: 'next',
    })
    expect(decodeSubagentRailStatus({ model: 'deepseek-v4-flash', phase: 'next' })).toBeUndefined()
    const raw = {
      ...JSON.parse(JSON.stringify(opened())) as Record<string, unknown>,
      subagent: { model: 'deepseek-v4-flash', effort: 'high', phase: 'next' },
    }
    expect(decodeDiscussionState(raw)).toEqual(opened())
    expect('subagent' in decodeDiscussionState(raw)).toBe(false)
  })
})
