/**
 * Discussion Mode subagent model selection. Duck-typed host seams only —
 * no DSH package imports. Empty until the user picks from the header chip
 * or `/discussion model`; spawn does not ask in-thread.
 */
import {
  DEFAULT_SUBAGENT_EFFORT,
  UNSET_SUBAGENT_MODEL,
  type SubagentRailStatus,
} from './contract.ts'

export const SUBAGENT_MODEL_QUESTION_ID = 'discussion-intent-subagent-model'
export const SUBAGENT_MODEL_SETTINGS_NS = 'discussion-intent'
export const UNSET_SUBAGENT_MODEL_HINT =
  'Discussion Mode subagent model is unset. Pick one from the header chip or /discussion model.'

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
  resolveCallConfig?(config: {
    readonly provider: string
    readonly model: string
  }): Promise<{ readonly reasoningEffort?: string }>
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
  const provider = trimmed.slice(0, slash).trim()
  const model = trimmed.slice(slash + 1).trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

export function formatSubagentModelCommandResult(
  models: readonly CatalogModel[],
  selected: ChildRoute | undefined,
): string {
  const current = selected === undefined
    ? 'unset. Pick one from the header chip or /discussion model <provider>/<id>.'
    : `${selected.provider}/${selected.model}. Change with the header chip or /discussion model <provider>/<id>.`
  const available = models.length === 0
    ? ['(empty catalog)']
    : models.map(model => `- ${optionLabel(model)}`)
  return [`Discussion Mode subagent model: ${current}`, 'Available:', ...available].join('\n')
}

export function decodeCatalogPayload(value: unknown): {
  readonly models: CatalogModel[]
  readonly selected?: ChildRoute
} | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly models?: unknown; readonly selected?: unknown }
  if (!Array.isArray(record.models)) return undefined
  const models: CatalogModel[] = []
  for (const item of record.models) {
    if (typeof item !== 'object' || item === null) continue
    const model = item as Record<string, unknown>
    const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    const name = typeof model.name === 'string' && model.name.trim() !== '' ? model.name : id
    if (provider === '' || id === '') continue
    models.push({
      provider,
      id,
      name,
      ...typeof model.description === 'string' && model.description !== '' ? { description: model.description } : {},
    })
  }
  const selected = readStoredRoute(record.selected)
  return selected === undefined ? { models } : { models, selected }
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

  async ensureChosen(): Promise<ChildRoute> {
    const stored = this.current()
    if (stored !== undefined) return stored
    throw new Error(UNSET_SUBAGENT_MODEL_HINT)
  }
}

export function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}/${route.model}`
}

export function subagentRailStatus(input: {
  readonly configured?: ChildRoute
  readonly effortByRoute?: ReadonlyMap<string, string>
  readonly running?: { readonly provider: string; readonly model: string; readonly effort?: string }
}): SubagentRailStatus {
  const effortOf = (route: { readonly provider: string; readonly model: string }, fallback?: string): string => {
    if (fallback !== undefined && fallback !== '') return fallback
    return input.effortByRoute?.get(routeKey(route)) ?? DEFAULT_SUBAGENT_EFFORT
  }
  if (input.running !== undefined) {
    return {
      model: input.running.model,
      effort: effortOf(input.running, input.running.effort),
      phase: 'running',
      ...input.running.provider === '' ? {} : { provider: input.running.provider },
    }
  }
  if (input.configured !== undefined) {
    return {
      provider: input.configured.provider,
      model: input.configured.model,
      effort: effortOf(input.configured),
      phase: 'next',
    }
  }
  return { model: UNSET_SUBAGENT_MODEL, effort: DEFAULT_SUBAGENT_EFFORT, phase: 'next' }
}

export async function materializeSpawnEffort(
  llm: LlmLike | undefined,
  route: ChildRoute,
): Promise<string> {
  if (llm?.resolveCallConfig === undefined) return DEFAULT_SUBAGENT_EFFORT
  try {
    const resolved = await llm.resolveCallConfig({ provider: route.provider, model: route.model })
    const effort = typeof resolved.reasoningEffort === 'string' ? resolved.reasoningEffort.trim() : ''
    return effort === '' ? DEFAULT_SUBAGENT_EFFORT : effort
  } catch {
    return DEFAULT_SUBAGENT_EFFORT
  }
}

/** In-memory overlay for the Rail: configured spawn plus any live child. */
export class SubagentRailTracker {
  private readonly effortByRoute = new Map<string, string>()
  private readonly running = new Map<string, {
    readonly parentSessionId: string
    readonly provider: string
    readonly model: string
    readonly effort?: string
  }>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly selection: SubagentModelSelection) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  status(parentSessionId: string): SubagentRailStatus {
    const running = this.runningFor(parentSessionId)
    const configured = this.selection.current()
    return subagentRailStatus({
      effortByRoute: this.effortByRoute,
      ...configured === undefined ? {} : { configured },
      ...running === undefined ? {} : { running },
    })
  }

  setEffort(route: ChildRoute, effort: string): void {
    const next = effort.trim() === '' ? DEFAULT_SUBAGENT_EFFORT : effort.trim()
    if (this.effortByRoute.get(routeKey(route)) === next) return
    this.effortByRoute.set(routeKey(route), next)
    this.notify()
  }

  markRunning(
    childId: string,
    parentSessionId: string,
    route: { readonly provider: string; readonly model: string; readonly effort?: string },
  ): void {
    this.running.set(childId, {
      parentSessionId,
      provider: route.provider,
      model: route.model,
      ...route.effort === undefined || route.effort === '' ? {} : { effort: route.effort },
    })
    this.notify()
  }

  markEnded(childId: string): void {
    if (!this.running.delete(childId)) return
    this.notify()
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }

  private runningFor(parentSessionId: string): {
    readonly provider: string
    readonly model: string
    readonly effort?: string
  } | undefined {
    let latest: { readonly provider: string; readonly model: string; readonly effort?: string } | undefined
    for (const entry of this.running.values()) {
      if (entry.parentSessionId === parentSessionId) latest = entry
    }
    return latest
  }
}
