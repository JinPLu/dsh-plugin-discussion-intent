/**
 * Discussion Mode subagent model selection. Duck-typed host seams only —
 * no DSH package imports. Empty until the user picks from the live catalog.
 */

export const SUBAGENT_MODEL_QUESTION_ID = 'discussion-intent-subagent-model'
export const SUBAGENT_MODEL_SETTINGS_NS = 'discussion-intent'

export interface ChildRoute {
  readonly provider: string
  readonly model: string
}

export interface ChildAgentOptionsLike {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

export interface CatalogModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface LlmLike {
  listProviders(): readonly { readonly id: string; readonly name?: string }[]
  listModels(provider: string): Promise<readonly {
    readonly provider?: string
    readonly id: string
    readonly name?: string
    readonly description?: string
  }[]>
}

export interface UserQuestionsLike {
  ask(request: {
    readonly questions: readonly {
      readonly id: string
      readonly question: string
      readonly header?: string
      readonly detail?: string
      readonly options?: readonly { readonly label: string; readonly description?: string }[]
    }[]
  }): Promise<{
    readonly answers: readonly {
      readonly id: string
      readonly selected: readonly string[]
      readonly custom?: string
    }[]
  }>
}

export interface SettingsScopeLike {
  get(): unknown
  replace(section: Record<string, string>): Promise<void>
}

export interface SettingsLike {
  register(
    ns: string,
    schema: unknown,
    options: { readonly base: Record<string, never> },
  ): SettingsScopeLike
}

export function readStoredRoute(value: unknown): ChildRoute | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

export function optionLabel(model: CatalogModel): string {
  return `${model.name} (${model.provider}/${model.id})`
}

export function parseCustomRoute(custom: string): ChildRoute | undefined {
  const trimmed = custom.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, slash).trim(), model: trimmed.slice(slash + 1).trim() }
}

export function mergeChildAgentOptions(
  request: { readonly agentOptions?: ChildAgentOptionsLike },
  defaults: ChildRoute,
): ChildAgentOptionsLike {
  return {
    ...defaults,
    ...request.agentOptions,
  }
}

export async function listAvailableModels(llm: LlmLike): Promise<CatalogModel[]> {
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const provider of llm.listProviders()) {
    let listed: readonly { readonly provider?: string; readonly id: string; readonly name?: string; readonly description?: string }[]
    try {
      listed = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of listed) {
      const route = `${model.provider ?? provider.id}/${model.id}`
      if (seen.has(route)) continue
      seen.add(route)
      models.push({
        provider: model.provider ?? provider.id,
        id: model.id,
        name: model.name === undefined || model.name === '' ? model.id : model.name,
        ...model.description === undefined ? {} : { description: model.description },
      })
    }
  }
  return models
}

export function routeFromAnswer(
  answer: {
    readonly answers: readonly {
      readonly id: string
      readonly selected: readonly string[]
      readonly custom?: string
    }[]
  },
  byLabel: ReadonlyMap<string, ChildRoute>,
): ChildRoute {
  const item = answer.answers.find(entry => entry.id === SUBAGENT_MODEL_QUESTION_ID)
  if (item === undefined) {
    throw new Error('Discussion Mode subagent model question was not answered')
  }
  if (item.custom !== undefined && item.custom.trim() !== '') {
    const custom = parseCustomRoute(item.custom)
    if (custom === undefined) {
      throw new Error(`Discussion Mode subagent model custom answer must be provider/model, got ${JSON.stringify(item.custom)}`)
    }
    return custom
  }
  const label = item.selected[0]
  if (label === undefined) {
    throw new Error('Discussion Mode subagent model is unset; choose a model from the current list')
  }
  const route = byLabel.get(label)
  if (route === undefined) {
    throw new Error(`Discussion Mode subagent model choice is not in the current list: ${label}`)
  }
  return route
}

export class SubagentModelSelection {
  private memory: ChildRoute | undefined
  private scope: SettingsScopeLike | undefined
  private asking: Promise<ChildRoute> | undefined

  attachSettings(settings: SettingsLike, schema: unknown): void {
    this.scope = settings.register(SUBAGENT_MODEL_SETTINGS_NS, schema, { base: {} })
    this.memory = readStoredRoute(this.scope.get())
  }

  current(): ChildRoute | undefined {
    return this.memory ?? readStoredRoute(this.scope?.get())
  }

  async persist(route: ChildRoute): Promise<void> {
    this.memory = route
    await this.scope?.replace({ provider: route.provider, model: route.model })
  }

  async ensureChosen(deps: {
    readonly llm?: LlmLike | undefined
    readonly userQuestions?: UserQuestionsLike | undefined
  }): Promise<ChildRoute> {
    const stored = this.current()
    if (stored !== undefined) return stored
    if (this.asking !== undefined) return this.asking
    this.asking = this.ask(deps).finally(() => {
      this.asking = undefined
    })
    return this.asking
  }

  private async ask(deps: {
    readonly llm?: LlmLike | undefined
    readonly userQuestions?: UserQuestionsLike | undefined
  }): Promise<ChildRoute> {
    if (deps.llm === undefined) {
      throw new Error('Discussion Mode subagent model is unset and no LLM catalog is available')
    }
    if (deps.userQuestions === undefined) {
      throw new Error('Discussion Mode subagent model is unset; ask_user_question requires a user-questions provider')
    }
    const models = await listAvailableModels(deps.llm)
    if (models.length === 0) {
      throw new Error('Discussion Mode subagent model is unset and the current catalog is empty')
    }
    const byLabel = new Map<string, ChildRoute>()
    const options = models.map(model => {
      const label = optionLabel(model)
      byLabel.set(label, { provider: model.provider, model: model.id })
      return {
        label,
        ...model.description === undefined ? {} : { description: model.description },
      }
    })
    const answer = await deps.userQuestions.ask({
      questions: [{
        id: SUBAGENT_MODEL_QUESTION_ID,
        header: 'Subagent model',
        question: 'Which model should Discussion Mode subagents use?',
        detail: 'Shown list is the catalog available right now. The parent thread model is unchanged. This choice is remembered until you change it.',
        options,
      }],
    })
    const route = routeFromAnswer(answer, byLabel)
    await this.persist(route)
    return route
  }
}
