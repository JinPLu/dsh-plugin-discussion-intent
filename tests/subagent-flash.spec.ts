import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, inject } from '../src/index.ts'

const FLASH = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const

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

async function harness() {
  const starts: CapturedStart[] = []
  const continuables: CapturedContinuable[] = []
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
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  ctx.provide('subagents', subagents)
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, { enabled: true, defaultIntensity: 2, directory: '.dsh/discussions' })
  }, { inject }))
  return { subagents, starts, continuables }
}

describe('optional subagents Flash wrap', () => {
  it('defaults start and startContinuable to deepseek-official / deepseek-v4-flash', async () => {
    const { subagents, starts, continuables } = await harness()
    const request = { prompt: 'child' }
    subagents.start('spawn', request)
    subagents.startContinuable({ request: { prompt: 'fork' } })
    expect(starts).toEqual([{ provider: 'spawn', request: { prompt: 'child', agentOptions: FLASH } }])
    expect(continuables).toEqual([{ request: { prompt: 'fork', agentOptions: FLASH } }])
  })

  it('lets explicit agentOptions fields override the Flash defaults', async () => {
    const { subagents, starts, continuables } = await harness()
    subagents.start('spawn', { agentOptions: { model: 'deepseek-v4-pro', maxTokens: 2048 } })
    subagents.startContinuable({
      request: { agentOptions: { provider: 'openai-codex', model: 'gpt-5.4' } },
    })
    expect(starts[0]?.request.agentOptions).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      maxTokens: 2048,
    })
    expect(continuables[0]?.request.agentOptions).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4',
    })
  })
})
