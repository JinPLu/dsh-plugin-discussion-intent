import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, inject } from '../src/index.ts'
import {
  listAvailableModels,
  optionLabel,
  parseCustomRoute,
  readStoredRoute,
  routeFromAnswer,
  SUBAGENT_MODEL_QUESTION_ID,
} from '../src/subagent-model.ts'

const FLASH = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const
const FLASH_LABEL = optionLabel({
  provider: FLASH.provider,
  id: FLASH.model,
  name: 'DeepSeek-V4-Flash',
})

interface ChildAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

interface CapturedRequest {
  readonly prompt?: string
  readonly agentOptions?: ChildAgentOptions
}

interface CapturedStart {
  readonly provider: string
  readonly request: CapturedRequest
}

interface CapturedContinuable {
  readonly request: CapturedRequest
}

interface QuestionRequest {
  readonly questions: readonly { readonly id: string; readonly options?: readonly { readonly label: string }[] }[]
}

async function harness(options?: {
  readonly stored?: { readonly provider?: string; readonly model?: string }
  readonly answer?: { readonly selected?: readonly string[]; readonly custom?: string }
  readonly skipAsk?: boolean
}) {
  const starts: CapturedStart[] = []
  const continuables: CapturedContinuable[] = []
  const asks: QuestionRequest[] = []
  const subagents = {
    start(provider: string, request: CapturedRequest) {
      starts.push({ provider, request })
      return { ok: true }
    },
    startContinuable(spec: CapturedContinuable) {
      continuables.push(spec)
      return { ok: true }
    },
  }
  const llm = {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'openai-codex', name: 'Codex' },
    ],
    async listModels(provider: string) {
      if (provider === 'deepseek-official') {
        return [
          { provider, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
          { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ]
      }
      return [{ provider, id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]
    },
  }
  const userQuestions = {
    async ask(request: QuestionRequest) {
      asks.push(request)
      if (options?.skipAsk === true) {
        return { answers: [{ id: SUBAGENT_MODEL_QUESTION_ID, selected: [] }] }
      }
      return {
        answers: [{
          id: SUBAGENT_MODEL_QUESTION_ID,
          selected: options?.answer?.selected ?? [FLASH_LABEL],
          ...options?.answer?.custom === undefined ? {} : { custom: options.answer.custom },
        }],
      }
    },
  }
  const settings = {
    register() {
      return {
        get: () => options?.stored ?? {},
        replace: async () => undefined,
      }
    },
  }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  ctx.provide('subagents', subagents)
  ctx.provide('llm', llm)
  ctx.provide('userQuestions', userQuestions)
  ctx.provide('settings', settings)
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
  }, { inject }))
  return { subagents, starts, continuables, asks }
}

describe('subagent model selection helpers', () => {
  it('treats missing or blank stored fields as empty', () => {
    expect(readStoredRoute(undefined)).toBeUndefined()
    expect(readStoredRoute({})).toBeUndefined()
    expect(readStoredRoute({ provider: 'deepseek-official', model: '' })).toBeUndefined()
    expect(readStoredRoute(FLASH)).toEqual(FLASH)
  })

  it('lists the current catalog and parses a custom provider/model', async () => {
    const models = await listAvailableModels({
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    })
    expect(models).toEqual([{
      provider: 'deepseek-official',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
    }])
    expect(parseCustomRoute('openai-codex/gpt-5.6-sol')).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    })
  })

  it('rejects a skipped ask answer', () => {
    expect(() => routeFromAnswer({
      answers: [{ id: SUBAGENT_MODEL_QUESTION_ID, selected: [] }],
    }, new Map())).toThrow(/unset/)
  })
})

describe('optional subagents model wrap', () => {
  it('asks from the live catalog when the stored selection is empty', async () => {
    const { subagents, starts, asks } = await harness()
    await subagents.start('spawn', { prompt: 'child' })
    expect(asks[0]?.questions[0]?.id).toBe(SUBAGENT_MODEL_QUESTION_ID)
    expect(asks[0]?.questions[0]?.options?.map(option => option.label)).toEqual([
      'DeepSeek-V4-Flash (deepseek-official/deepseek-v4-flash)',
      'DeepSeek-V4-Pro (deepseek-official/deepseek-v4-pro)',
      'GPT-5.6 Sol (openai-codex/gpt-5.6-sol)',
    ])
    expect(starts).toEqual([{
      provider: 'spawn',
      request: { prompt: 'child', agentOptions: FLASH },
    }])
  })

  it('reuses a stored selection and does not ask again', async () => {
    const { subagents, starts, continuables, asks } = await harness({
      stored: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
    })
    await subagents.start('spawn', { prompt: 'child' })
    await subagents.startContinuable({ request: { prompt: 'fork' } })
    expect(asks).toEqual([])
    expect(starts[0]?.request.agentOptions).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    })
    expect(continuables[0]?.request.agentOptions).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    })
  })

  it('lets explicit agentOptions fields override the chosen route', async () => {
    const { subagents, starts } = await harness({
      stored: FLASH,
    })
    await subagents.start('spawn', { agentOptions: { model: 'deepseek-v4-pro', maxTokens: 2048 } })
    expect(starts[0]?.request.agentOptions).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      maxTokens: 2048,
    })
  })

  it('does not inherit a parent model when the user skips the question', async () => {
    const { subagents } = await harness({ skipAsk: true })
    await expect(subagents.start('spawn', { prompt: 'child' })).rejects.toThrow(/unset/)
  })
})
