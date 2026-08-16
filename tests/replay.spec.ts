import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discussionRailRows, NO_TOPIC_YET } from '../src/contract.ts'
import { apply, inject } from '../src/index.ts'
import { SUBAGENT_MODEL_QUESTION_ID } from '../src/subagent-model.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const OPENING = '查看 ～/.codex/sessions 的 codex://threads/01a0075e-494a-7b71-a41f-422204c01744，我需要和你继续讨论论文主线。怎么从现在的主线来优化。'
const ACCEPT_D = '接受 D：给定 W，只学习显式电影决策 C 与连续执行计划 Z。'
const BERNINI = 'vlm能否理解 vlm输出的vit embedding，按理说vit embedding也是vlm的注入，他应该能看懂吧。这个是有待验证的点，如果验证成功，我们所谓的 Editable VLM Visual Director，可以先自己看自己画的“草稿分镜构图、计划”自己先修吧'
const REFRESH = '更新当前的讨论情况。包括焦点，我说过的点、当前理解、下一步等'
const CRITERION = '充分理解我的要求（每个agent讨论中我给出的引导）'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-replay-'))
  temporaryRoots.push(root)
  const asks: unknown[] = []
  const userQuestions = {
    async ask(request: { readonly questions: readonly { readonly id: string }[] }) {
      asks.push(request)
      const id = request.questions[0]?.id ?? 'direction'
      return { answers: [{ id, selected: [ACCEPT_D] }] }
    },
  }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  ctx.provide('userQuestions', userQuestions)
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
  }, { inject }))
  const session = ctx.sessions.create(SessionId('session-5c9c59e2'), { meta: { cwd: root } })
  const agent = buildAgent(session)
  return { ctx, session, agent, asks }
}

function directUser(session: ReturnType<SessionStore['create']>, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('session-5c9c59e2 replay shape', () => {
  it('keeps Rail Focus off the Codex URL after Bernini and does not leave You as only spawn subagents', async () => {
    const { ctx, session, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const opening = directUser(session, `${OPENING}\nspawn subagents\n${CRITERION}`)
    const afterOpening = await ctx.tools.execute({
      callId: CallId('replay-opening'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 1,
        captures: [
          { kind: 'goal', quote: OPENING, eventSeq: opening.seq },
          { kind: 'decision', quote: 'spawn subagents', eventSeq: opening.seq },
          { kind: 'criterion', quote: CRITERION, eventSeq: opening.seq },
        ],
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(afterOpening.isError).toBe(false)
    const opened = ctx.discussionIntent.get(agent)
    expect(opened?.goal).toBe(NO_TOPIC_YET)
    expect(opened?.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(opened?.focus.currentQuestion).toBe(OPENING)

    await (ctx.get('userQuestions') as {
      ask(request: { readonly questions: readonly { readonly id: string; readonly question: string }[]; readonly agent?: Agent }): Promise<unknown>
    }).ask({
      agent,
      questions: [{ id: 'paper-direction', question: '接受哪个论文方向？' }],
    })
    const afterAsk = ctx.discussionIntent.get(agent)
    expect(afterAsk?.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(afterAsk?.focus.currentQuestion).toBe(ACCEPT_D)
    expect(afterAsk?.humanFrame.some(frame => (
      frame.kind === 'decision' && frame.statement === ACCEPT_D && frame.source.origin === 'ask_user_question'
    ))).toBe(true)

    const bernini = directUser(session, BERNINI)
    const afterBernini = await ctx.tools.execute({
      callId: CallId('replay-bernini'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: afterAsk!.revision,
        captures: [{ kind: 'criterion', quote: BERNINI, eventSeq: bernini.seq }],
        focus: {
          currentQuestion: BERNINI,
          level: 'mechanism',
          returnTo: ACCEPT_D,
        },
        historySummary: 'Sank working focus to the Bernini self-read question.',
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(afterBernini.isError).toBe(false)
    const dived = ctx.discussionIntent.get(agent)
    expect(dived?.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
    expect(dived?.focus.currentQuestion).toBe(BERNINI)
    expect(dived?.pendingFrameChanges.some(change => change.target === 'root-focus' && change.status === 'pending')).toBe(false)

    const refresh = directUser(session, REFRESH)
    const afterRefresh = await ctx.tools.execute({
      callId: CallId('replay-refresh'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: dived!.revision,
        captures: [{ kind: 'criterion', quote: REFRESH, eventSeq: refresh.seq }],
        synthesis: {
          interpretation: 'Direction D is accepted; the live question is Bernini self-read.',
          nextStep: 'Verify whether the same VLM can reread sampled ViT embeddings.',
        },
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(afterRefresh.isError).toBe(false)
    const finalState = ctx.discussionIntent.get(agent)!
    const rows = discussionRailRows(finalState)
    const focus = rows.find(row => row.label === 'Focus')?.value
    const you = rows.find(row => row.label === 'You')?.value
    expect(focus).toBe(BERNINI)
    expect(focus).not.toContain('codex://threads/01a0075e-494a-7b71-a41f-422204c01744')
    expect(you).toContain(ACCEPT_D)
    expect(you).toContain(CRITERION)
    expect(you).toContain(BERNINI)
    expect(you).not.toBe('spawn subagents')
    expect(you).not.toContain('spawn subagents')
    expect(you).not.toContain('更新当前的讨论情况')
    expect(finalState.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
  })

  it('resolves an ask_user_question tool result when discussion_update quotes the option label', async () => {
    const { ctx, session, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    const callId = CallId('ask-accept-d')
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'ask_user_question',
      arguments: '{"questions":[{"id":"paper-direction"}]}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'paper-direction', selected: [ACCEPT_D] }] }) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const result = await ctx.tools.execute({
      callId: CallId('replay-auq-capture'),
      name: 'discussion_update',
      arguments: {
        expectedRevision: 1,
        captures: [{ kind: 'decision', quote: ACCEPT_D }],
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(false)
    const state = ctx.discussionIntent.get(agent)
    expect(state?.humanFrame[0]).toMatchObject({
      kind: 'decision',
      statement: ACCEPT_D,
      source: { origin: 'ask_user_question' },
    })
    expect(state?.rootFocus.currentQuestion).toBe(NO_TOPIC_YET)
  })

  it('does not host-capture the subagent model questionnaire as a discussion decision', async () => {
    const { ctx, agent } = await harness()
    await ctx.commands.execute(agent, '/discussion 3', new AbortController().signal)
    await (ctx.get('userQuestions') as {
      ask(request: { readonly questions: readonly { readonly id: string; readonly question: string }[]; readonly agent?: Agent }): Promise<unknown>
    }).ask({
      agent,
      questions: [{ id: SUBAGENT_MODEL_QUESTION_ID, question: 'Which model should Discussion Mode subagents use?' }],
    })
    expect(ctx.discussionIntent.get(agent)?.humanFrame).toEqual([])
  })
})
