import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyDiscussionUpdate,
  createDiscussionState,
  discussionRailRows,
  NO_TOPIC_YET,
  renderDiscussionPolicy,
  UNTITLED_TITLE,
} from '../src/contract.ts'
import { apply, inject } from '../src/index.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function buildAgent(session: ReturnType<SessionStore['create']>): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    steer(message: UserMessage) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as unknown as Agent
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-antidrift-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
  }, { inject }))
  const session = ctx.sessions.create(SessionId('world-model-anti-drift'), { meta: { cwd: root } })
  const agent = buildAgent(session)
  return { ctx, session, agent }
}

function directUser(session: ReturnType<SessionStore['create']>, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

const LOCKS = [
  {
    kind: 'constraint' as const,
    quote: 'World Model is an offline data engine by default; online active interaction is a separate high-risk direction.',
  },
  {
    kind: 'preference' as const,
    quote: 'Do not use defensive wording; say it in plain language.',
  },
  {
    kind: 'decision' as const,
    quote: 'The result must support a Demo, a report, and a paper description.',
  },
  {
    kind: 'criterion' as const,
    quote: 'Action precision is a capability gate; OOD is the core evaluation axis.',
  },
  {
    kind: 'constraint' as const,
    quote: 'Split wording work into another task, then return this discussion to the experiment plan.',
  },
  {
    kind: 'rejection' as const,
    quote: 'Occlusion and revisit are optional stress tests, not the Topic.',
  },
]

describe('WorldModel / Codex-thread anti-drift', () => {
  it('keeps the six direct-user locks as Human Frames', async () => {
    const { ctx, session, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const captures = LOCKS.map(lock => ({
      kind: lock.kind,
      quote: lock.quote,
      eventSeq: directUser(session, lock.quote).seq,
    }))
    const result = await ctx.tools.execute({
      callId: CallId('anti-drift-locks'),
      name: 'discussion_update',
      arguments: { expectedRevision: 1, captures },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(false)
    const state = ctx.discussionIntent.get(agent)
    expect(state?.humanFrame).toHaveLength(6)
    expect(state?.humanFrame.map(frame => frame.statement)).toEqual(LOCKS.map(lock => lock.quote))
    expect(state?.humanFrame.every(frame => frame.status === 'active')).toBe(true)
    expect(state?.focus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(state?.rootFocus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(state?.focus.level).toBe('project')
    const you = discussionRailRows(state!).find(row => row.label === 'You')?.value
    expect(you).toContain(LOCKS[2]!.quote)
    expect(you).toContain(LOCKS[3]!.quote)
    expect(you).toContain(LOCKS[5]!.quote)
    expect(state!.humanFrame.slice(-2).map(frame => frame.kind)).toEqual(['constraint', 'rejection'])
    const policy = renderDiscussionPolicy(state!)
    expect(policy).toContain(LOCKS[0]!.quote)
    expect(policy).toContain(LOCKS[5]!.quote)
    expect(policy).toContain('[rejection]')
    expect(policy).toContain('[decision]')
  })

  it('keeps research-shaped occlusion or active-interaction evidence as candidates', () => {
    const opened = createDiscussionState({ id: 'world-model-research', intensity: 3, now: 1 })
    const locked = applyDiscussionUpdate(opened, {
      expectedRevision: 1,
      captures: LOCKS.map((lock, index) => ({
        kind: lock.kind,
        quote: lock.quote,
        eventSeq: index + 1,
      })),
    }, 2)
    const researched = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      provisionalTitle: 'Occlusion-centric persistent interaction World Model',
      focus: {
        currentQuestion: 'How should occlusion and active interaction become the root experiment?',
        level: 'direction',
      },
      optionUpdates: [
        {
          id: 'occlusion-memory',
          title: 'Occlusion-centric persistent memory',
          evidenceFor: ['A new paper shows occlusion demos well.'],
          status: 'open',
        },
        {
          id: 'active-interaction',
          title: 'Active Physical Discovery',
          evidenceFor: ['Live interaction may improve a different high-risk track.'],
          status: 'open',
        },
      ],
      historySummary: 'Research added occlusion and active-interaction candidates.',
    }, 3)
    expect(researched.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(researched.focus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(researched.rootFocus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(researched.options.map(option => option.id)).toEqual(['occlusion-memory', 'active-interaction'])
    expect(researched.options.every(option => option.status === 'open')).toBe(true)
    expect(researched.pendingFrameChanges).toMatchObject([
      { status: 'pending', target: 'title', proposed: 'Occlusion-centric persistent interaction World Model' },
      { status: 'pending', target: 'root-focus', proposed: 'How should occlusion and active interaction become the root experiment?' },
    ])
    expect(renderDiscussionPolicy(researched)).toContain('Occlusion and revisit are optional stress tests, not the Topic.')
    expect(renderDiscussionPolicy(researched)).toContain('It cannot silently replace title, goal, root focus')
    expect(renderDiscussionPolicy(researched)).toContain('must not auto-lock the root')
    expect(renderDiscussionPolicy(researched)).not.toContain('Ask one question at a time')
    expect(discussionRailRows(researched).find(row => row.label === 'Pending')?.value).toContain('/discussion accept')
    expect(discussionRailRows(researched).map(row => row.label)).toEqual([
      'Focus',
      'You',
      'Understanding',
      'Next',
      'Pending',
    ])
  })

  it('supersedes an old frame only with a new proving quote, and keeps the correction visible', () => {
    const opened = createDiscussionState({ id: 'world-model-correction', intensity: 3, now: 1 })
    const locked = applyDiscussionUpdate(opened, {
      expectedRevision: 1,
      captures: [{
        kind: 'constraint',
        quote: LOCKS[0]!.quote,
        eventSeq: 1,
      }],
    }, 2)
    const original = locked.humanFrame[0]!
    expect(() => applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      supersedeStatementIds: [original.id],
    }, 3)).toThrow('supersedeStatementIds requires a new same-session proving quote')
    expect(() => applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      captures: [{
        kind: 'constraint',
        quote: LOCKS[0]!.quote,
        eventSeq: 1,
      }],
      supersedeStatementIds: [original.id],
    }, 3)).toThrow('supersedeStatementIds requires a new same-session proving quote')
    const corrected = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      captures: [{
        kind: 'decision',
        quote: 'I decide to keep the offline engine boundary. Do not promote Active Physical Discovery, persistent state, or occlusion into the root direction.',
        eventSeq: 8,
      }],
      supersedeStatementIds: [original.id],
    }, 4)
    expect(corrected.humanFrame.find(frame => frame.id === original.id)?.status).toBe('superseded')
    expect(corrected.humanFrame.at(-1)).toMatchObject({
      kind: 'decision',
      status: 'active',
      statement: 'I decide to keep the offline engine boundary. Do not promote Active Physical Discovery, persistent state, or occlusion into the root direction.',
    })
    expect(renderDiscussionPolicy(corrected)).toContain('I decide to keep the offline engine boundary')
    expect(discussionRailRows(corrected).find(row => row.label === 'You')?.value).toContain('offline engine boundary')
  })

  it('rejects forged quotes and does not steer an infer-topic notice on /discussion 3', async () => {
    const { ctx, session, agent } = await harness()
    const first = await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    expect(first?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('3=deep'),
    })
    expect(String((first?.result as { text?: string } | undefined)?.text)).toContain('Intensity only')
    expect(String((first?.result as { text?: string } | undefined)?.text)).not.toContain('inferred')
    const state = ctx.discussionIntent.get(agent)
    expect(state).toMatchObject({
      active: true,
      intensity: 3,
      provisionalTitle: UNTITLED_TITLE,
      goal: NO_TOPIC_YET,
    })
    expect(state?.focus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(session.events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)
    const same = await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    expect(same?.result).toMatchObject({ kind: 'success' })
    expect(session.events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)
    const forged = await ctx.tools.execute({
      callId: CallId('anti-drift-forged'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 1,
        captures: [{ kind: 'decision', quote: 'The user chose the occlusion direction.' }],
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(forged.isError).toBe(true)
    expect(forged.content.some(block => block.type === 'text' && block.text.includes('No same-session direct user message'))).toBe(true)
  })

  it('cannot reopen a confirmed lock without /discussion accept', async () => {
    const { ctx, session, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const lock = directUser(session, '可以，先落盘主线')
    await ctx.tools.execute({
      callId: CallId('anti-drift-confirm'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 1,
        captures: [{ kind: 'decision', quote: '可以，先落盘主线', eventSeq: lock.seq }],
      },
      signal: new AbortController().signal,
      agent,
    })
    const afterLock = ctx.discussionIntent.get(agent)
    expect(afterLock?.focus.currentQuestion).toBe('可以，先落盘主线')
    expect(afterLock?.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(afterLock?.focus.level).toBe('project')
    const novelty = await ctx.tools.execute({
      callId: CallId('anti-drift-novelty'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 2,
        provisionalTitle: 'A newly invented P1 benchmark',
        focus: {
          currentQuestion: 'What new thinking should reopen the topic?',
          level: 'project',
        },
        optionUpdates: [{
          id: 'novelty',
          title: '有什么新的思考',
          evidenceFor: ['A later paper suggests a different root question.'],
          status: 'open',
        }],
        historySummary: 'Research tried to reopen the locked thesis.',
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(novelty.isError).toBe(false)
    const afterResearch = ctx.discussionIntent.get(agent)
    expect(afterResearch?.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(afterResearch?.focus.currentQuestion).toBe('可以，先落盘主线')
    expect(afterResearch?.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(afterResearch?.focus.level).toBe('project')
    expect(afterResearch?.humanFrame.some(frame => frame.statement === '可以，先落盘主线' && frame.status === 'active')).toBe(true)
    expect(afterResearch?.pendingFrameChanges.some(change => change.target === 'root-focus' && change.status === 'pending')).toBe(true)
    const pendingId = afterResearch?.pendingFrameChanges.find(change => change.target === 'title')?.id
    expect(pendingId).toBeDefined()
    const rejected = await ctx.commands.execute(agent, `/discussion reject ${pendingId!}`, new AbortController().signal)
    expect(rejected?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('rejected') })
    expect(ctx.discussionIntent.get(agent)?.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(ctx.discussionIntent.get(agent)?.focus.currentQuestion).toBe('可以，先落盘主线')
  })

  it('hard-rejects occlusion nextStep or favored while interpretation may still discuss it', () => {
    const opened = createDiscussionState({ id: 'world-model-contradiction', intensity: 3, now: 1 })
    const locked = applyDiscussionUpdate(opened, {
      expectedRevision: 1,
      captures: LOCKS.map((lock, index) => ({
        kind: lock.kind,
        quote: lock.quote,
        eventSeq: index + 1,
      })),
    }, 2)
    const researched = applyDiscussionUpdate(locked, {
      expectedRevision: 2,
      provisionalTitle: 'Occlusion-centric persistent interaction World Model',
      focus: {
        currentQuestion: 'How should occlusion and active interaction become the root experiment?',
        level: 'direction',
      },
      optionUpdates: [{
        id: 'occlusion-memory',
        title: 'Occlusion-centric persistent memory',
        evidenceFor: ['A new paper shows occlusion demos well.'],
        status: 'open',
      }],
      synthesis: {
        interpretation: 'Occlusion remains an optional stress-test candidate, not the thesis.',
      },
      historySummary: 'Research added an occlusion candidate without promoting it.',
    }, 3)
    expect(researched.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(researched.focus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(researched.rootFocus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(researched.pendingFrameChanges).toMatchObject([
      { status: 'pending', target: 'title', proposed: 'Occlusion-centric persistent interaction World Model' },
      { status: 'pending', target: 'root-focus', proposed: 'How should occlusion and active interaction become the root experiment?' },
    ])
    expect(() => applyDiscussionUpdate(researched, {
      expectedRevision: 3,
      synthesis: { nextStep: 'Make occlusion the root experiment.' },
    }, 4)).toThrow('next step collides with an active rejection')
    expect(() => applyDiscussionUpdate(researched, {
      expectedRevision: 3,
      optionUpdates: [{ id: 'occlusion-memory', status: 'favored' }],
    }, 4)).toThrow('favored option')
    expect(() => applyDiscussionUpdate(researched, {
      expectedRevision: 3,
      optionUpdates: [{
        id: 'occlusion-root',
        title: 'Occlusion-centric persistent memory',
        status: 'favored',
      }],
    }, 4)).toThrow('favored option')
    expect(() => applyDiscussionUpdate(researched, {
      expectedRevision: 3,
      synthesis: { nextStep: LOCKS[5]!.quote },
    }, 4)).not.toThrow()
    const cited = applyDiscussionUpdate(researched, {
      expectedRevision: 3,
      synthesis: { nextStep: LOCKS[5]!.quote },
    }, 4)
    expect(cited.synthesis.nextStep).toBe(LOCKS[5]!.quote)
    expect(cited.focus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(cited.rootFocus.currentQuestion).toBe(LOCKS[2]!.quote)
    const interpreted = applyDiscussionUpdate(researched, {
      expectedRevision: 3,
      synthesis: {
        interpretation: 'Occlusion remains an optional candidate for a later stress test.',
      },
    }, 4)
    expect(interpreted.synthesis.interpretation).toContain('Occlusion')
    expect(interpreted.provisionalTitle).toBe(UNTITLED_TITLE)
    expect(interpreted.focus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(interpreted.rootFocus.currentQuestion).toBe(LOCKS[2]!.quote)
    expect(interpreted.pendingFrameChanges).toMatchObject([
      { status: 'pending', target: 'title' },
      { status: 'pending', target: 'root-focus' },
    ])
  })
})
