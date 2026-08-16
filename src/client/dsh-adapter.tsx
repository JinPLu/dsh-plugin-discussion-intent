/**
 * DSH client adapter: the named boundary where the web client imports DSH
 * client packages and wires the host slot/locale services. The client package
 * entry (`index.tsx`) is a thin facade over this module; the rendered rows
 * come from the DSH-independent `contract.ts`.
 */
import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  activePendingFrameChanges,
  decodeDiscussionState,
  decodeSubagentRailStatus,
  DEFAULT_SUBAGENT_EFFORT,
  discussionRailRows,
  intensityName,
  NO_TOPIC_YET,
  shortSubagentModel,
  UNSET_SUBAGENT_MODEL,
  type DiscussionState,
  type SubagentRailStatus,
} from '../contract.ts'
import {
  decodeCatalogPayload,
  optionLabel,
  type CatalogModel,
  type ChildRoute,
} from '../subagent-model.ts'

export const name = 'discussion-intent-client'
export const inject = ['slots', 'locale']

const zh = {
  title: 'Discussion Mode',
  headerTitle: '讨论中',
  noFocus: '还没有工作焦点',
  saved: '已落盘',
  unsaved: '未落盘',
  Focus: '当前焦点',
  You: '你明确说过',
  Understanding: '当前理解',
  Next: '下一步',
  Pending: '待确认',
  subagentLabel: '子代理',
  subagentRunning: '进行中',
  subagentUnset: '未选',
} as const

type DiscussionLocaleKey = keyof typeof zh

const en: Record<DiscussionLocaleKey, string> = {
  title: 'Discussion Mode',
  headerTitle: 'In discussion',
  noFocus: 'No working focus yet',
  saved: 'saved',
  unsaved: 'not saved',
  Focus: 'Focus',
  You: 'You said',
  Understanding: 'Understanding',
  Next: 'Next',
  Pending: 'Pending',
  subagentLabel: 'subagent',
  subagentRunning: 'running',
  subagentUnset: 'unset',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    discussionIntent: DiscussionLocaleKey
  }
}

const styles = {
  dock: {
    boxSizing: 'border-box',
    width: 'calc(100% - 4 * var(--dsh-composer-dock-inset))',
    margin: '0 auto',
  },
  rail: {
    boxSizing: 'border-box',
    position: 'relative',
    width: '100%',
    maxWidth: 'calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset))',
    margin: '0 auto',
    padding: '9px 12px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    background: 'var(--dsw-specific-tip)',
  },
  railCollapsed: {
    padding: '4px 12px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 28,
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
  },
  headerOpen: {
    marginBottom: 8,
    paddingBottom: 7,
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  headerTitle: {
    flex: 'none',
    fontSize: 13,
    fontWeight: 600,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  headerFocus: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  headerCluster: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    flex: 1,
    gap: 6,
  },
  headerMeta: {
    display: 'flex',
    alignItems: 'center',
    flex: 'none',
    gap: 6,
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: 220,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '1px 7px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '72px minmax(0, 1fr)',
    alignItems: 'baseline',
    gap: 8,
    minHeight: 22,
    cursor: 'pointer',
  },
  label: {
    fontSize: 12,
    lineHeight: '20px',
    fontWeight: 600,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  value: {
    minWidth: 0,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  valueExpanded: {
    display: 'block',
    overflow: 'visible',
    WebkitLineClamp: 'unset',
    WebkitBoxOrient: 'unset',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  modelValue: {
    color: 'var(--dsw-alias-label-primary-dimmed)',
  },
  iconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    border: 'none',
    borderRadius: 999,
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'default',
  },
  picker: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 12,
    zIndex: 2,
    width: 280,
    maxHeight: 180,
    overflowY: 'auto',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    background: 'var(--dsw-specific-tip)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
  },
  pickerItem: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    border: 'none',
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)',
  },
} as const

export const RAIL_HEADER_FOCUS_LIMIT = 120

/** Official AnchorRail compactText: 120 graphemes, then an ellipsis. */
export function compactRailText(value: string, limit = RAIL_HEADER_FOCUS_LIMIT): string {
  const characters = Array.from(value.trim())
  return characters.length <= limit ? characters.join('') : `${characters.slice(0, limit - 1).join('')}…`
}

export function railHeaderNarrative(
  state: DiscussionState,
  emptyLabel: string,
): { readonly full: string; readonly display: string; readonly empty: boolean } {
  const full = discussionRailRows(state).find(row => row.label === 'Focus')?.value ?? ''
  const empty = full === '' || full === NO_TOPIC_YET
  return {
    full: empty ? emptyLabel : full,
    display: empty ? emptyLabel : compactRailText(full),
    empty,
  }
}

export function toggleExpandedRailRow(
  current: string | undefined,
  label: string,
): string | undefined {
  return current === label ? undefined : label
}

export function railValueStyle(expanded: boolean, authority: 'human' | 'model'): CSSProperties {
  const base = authority === 'human' ? styles.value : { ...styles.value, ...styles.modelValue }
  return expanded ? { ...base, ...styles.valueExpanded } : base
}

export const HIDE_GOAL_BAR_CSS = '[data-goal-bar]{display:none!important}'

export function formatLocalizedSubagentRailStatus(
  status: SubagentRailStatus,
  t: (key: DiscussionLocaleKey) => string,
): string {
  if (status.model === UNSET_SUBAGENT_MODEL) return `${t('subagentLabel')} ${t('subagentUnset')}`
  const model = shortSubagentModel(status.model)
  const effort = status.effort === '' || status.effort === DEFAULT_SUBAGENT_EFFORT ? '' : ` · ${status.effort}`
  if (status.phase === 'running') return `${t('subagentRunning')} · ${model}${effort}`
  return `${model}${effort}`
}

function CheckpointGlyph({ status }: { readonly status: 'saved' | 'unsaved' | 'error' }) {
  if (status === 'saved') {
    return (
      <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 8.5 6.5 12 13 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.2" r="0.7" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export interface DiscussionRailProps extends PropsLocale<'discussionIntent'> {
  readonly state: DiscussionState | null | undefined
  readonly subagent?: SubagentRailStatus
  readonly open?: boolean
  readonly onToggleOpen?: () => void
  readonly expandedLabel?: string
  readonly onToggleRow?: (label: string) => void
  readonly pickerOpen?: boolean
  readonly catalog?: readonly CatalogModel[]
  readonly onTogglePicker?: () => void
  readonly onPickSubagent?: (route: ChildRoute) => void
}

/** Collapsed to a GoalBar-like header by default. Click the title/focus to open
 *  the four read-only rows (Pending is a fifth). Focus cell text is composed by
 *  the contract. Subagent model/effort is a header chip. Open rows clamp to two
 *  lines; click expands that row only. The model chip opens the catalog picker. */
export function DiscussionRail({
  state,
  subagent,
  t,
  open = false,
  onToggleOpen,
  expandedLabel,
  onToggleRow,
  pickerOpen = false,
  catalog = [],
  onTogglePicker,
  onPickSubagent,
}: DiscussionRailProps) {
  if (state?.active !== true) return null
  const saved = state.checkpoint.status === 'saved'
  const spawn = subagent === undefined ? undefined : formatLocalizedSubagentRailStatus(subagent, t)
  const canPick = subagent !== undefined && subagent.phase !== 'running' && onTogglePicker !== undefined
  const pendingCount = activePendingFrameChanges(state).length
  const narrative = railHeaderNarrative(state, t('noFocus'))
  const stop = (event: MouseEvent) => { event.stopPropagation() }
  const checkpointStatus = state.checkpoint.status === 'error' ? 'error' : saved ? 'saved' : 'unsaved'
  return (
    <div style={styles.dock} data-discussion-intent-rail data-discussion-rail-open={open ? 'true' : 'false'}>
      <aside style={open ? styles.rail : { ...styles.rail, ...styles.railCollapsed }} aria-label={t('title')}>
        <style data-discussion-hide-goal>{HIDE_GOAL_BAR_CSS}</style>
        <div
          style={open ? { ...styles.header, ...styles.headerOpen } : styles.header}
          data-discussion-intent-header
          {...onToggleOpen === undefined ? {} : { onClick: onToggleOpen }}
        >
          <div style={styles.headerCluster}>
            <span style={styles.headerTitle} data-discussion-header-title>{t('headerTitle')}</span>
            <span style={styles.headerFocus} data-discussion-header-focus title={narrative.full}>
              {narrative.display}
            </span>
          </div>
          <div style={styles.headerMeta} onClick={stop}>
            <span style={styles.chip} data-discussion-intensity>
              {intensityName(state.intensity)}
            </span>
            {subagent === undefined || spawn === undefined ? undefined : (
              <span
                style={canPick ? { ...styles.chip, cursor: 'pointer' } : styles.chip}
                data-discussion-subagent
                data-discussion-subagent-phase={subagent.phase}
                title={spawn}
                {...canPick ? {
                  role: 'button',
                  onClick: (event: MouseEvent) => {
                    event.stopPropagation()
                    onTogglePicker()
                  },
                } : {}}
              >
                {spawn}
              </span>
            )}
            {pendingCount === 0 ? undefined : (
              <span style={styles.chip} data-discussion-pending-count>
                {`${t('Pending')} ${String(pendingCount)}`}
              </span>
            )}
            <span
              style={styles.iconBtn}
              data-discussion-checkpoint
              data-discussion-checkpoint-status={checkpointStatus}
              aria-label={t(saved ? 'saved' : 'unsaved')}
              title={state.checkpoint.status === 'error' ? state.checkpoint.message : t(saved ? 'saved' : 'unsaved')}
            >
              <CheckpointGlyph status={checkpointStatus} />
            </span>
          </div>
        </div>
        {pickerOpen ? (
          <div style={styles.picker} data-discussion-subagent-picker>
            {catalog.map(model => {
              const route = `${model.provider}/${model.id}`
              return (
                <button
                  key={route}
                  type="button"
                  style={styles.pickerItem}
                  data-discussion-subagent-option={route}
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation()
                    onPickSubagent?.({ provider: model.provider, model: model.id })
                  }}
                >
                  {optionLabel(model)}
                </button>
              )
            })}
          </div>
        ) : undefined}
        {open ? discussionRailRows(state).map(row => {
          const expanded = expandedLabel === row.label
          return (
            <section
              key={row.label}
              style={onToggleRow === undefined ? { ...styles.row, cursor: 'default' } : styles.row}
              aria-label={t(row.label)}
              data-discussion-rail-row={row.label}
              data-expanded={expanded ? 'true' : 'false'}
              onClick={onToggleRow === undefined ? undefined : () => { onToggleRow(row.label) }}
            >
              <span style={styles.label}>{t(row.label)}</span>
              <span
                style={railValueStyle(expanded, row.authority)}
                data-authority={row.authority}
                title={row.value}
              >
                {row.value}
              </span>
            </section>
          )
        }) : undefined}
      </aside>
    </div>
  )
}

export const DISCUSSION_INTENT_STATE_PATH = '/dsh/discussion-intent/state'
export const DISCUSSION_INTENT_MODELS_PATH = '/dsh/discussion-intent/models'
export const DISCUSSION_INTENT_SUBAGENT_PATH = '/dsh/discussion-intent/subagent'

export async function fetchSubagentCatalog(): Promise<CatalogModel[]> {
  const response = await fetch(DISCUSSION_INTENT_MODELS_PATH, { cache: 'no-store' })
  if (!response.ok) return []
  return decodeCatalogPayload(await response.json() as unknown)?.models ?? []
}

export async function postSubagentRoute(route: ChildRoute): Promise<boolean> {
  const response = await fetch(DISCUSSION_INTENT_SUBAGENT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: route.provider, model: route.model }),
  })
  return response.ok
}

function InteractiveDiscussionRail({ state, subagent, t }: DiscussionRailProps) {
  const [open, setOpen] = useState(false)
  const [expandedLabel, setExpandedLabel] = useState<string | undefined>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  return (
    <DiscussionRail
      state={state}
      {...subagent === undefined ? {} : { subagent }}
      t={t}
      open={open}
      onToggleOpen={() => { setOpen(current => !current) }}
      {...expandedLabel === undefined ? {} : { expandedLabel }}
      onToggleRow={label => { setExpandedLabel(current => toggleExpandedRailRow(current, label)) }}
      pickerOpen={pickerOpen}
      catalog={catalog}
      onTogglePicker={() => {
        if (subagent?.phase === 'running') return
        setPickerOpen(open => {
          const next = !open
          if (next) void fetchSubagentCatalog().then(setCatalog)
          return next
        })
      }}
      onPickSubagent={route => {
        void postSubagentRoute(route).then(ok => {
          if (ok) setPickerOpen(false)
        })
      }}
    />
  )
}

export function discussionIntentStatePath(sessionId: string): string {
  return `${DISCUSSION_INTENT_STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}`
}

export type ClassifiedLivePayload =
  | { readonly kind: 'state'; readonly state: DiscussionState; readonly subagent?: SubagentRailStatus }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'invalid' }

function liveSnapshot(
  sessionId: string,
  state: DiscussionState,
  subagent?: SubagentRailStatus,
): LiveDiscussionSnapshot {
  return subagent === undefined ? { sessionId, state } : { sessionId, state, subagent }
}

/**
 * Decode one live wire payload. `{ active: false }` is a real "no discussion"
 * snapshot. Malformed input is `invalid` and must not hide a previous frame.
 */
export function classifyLivePayload(value: unknown): ClassifiedLivePayload {
  if (typeof value !== 'object' || value === null) return { kind: 'invalid' }
  const candidate = value as { readonly active?: unknown; readonly revision?: unknown; readonly subagent?: unknown }
  if (candidate.active === false) return { kind: 'inactive' }
  if (candidate.active !== true || typeof candidate.revision !== 'number') return { kind: 'invalid' }
  try {
    const subagent = decodeSubagentRailStatus(candidate.subagent)
    return subagent === undefined
      ? { kind: 'state', state: decodeDiscussionState(value) }
      : { kind: 'state', state: decodeDiscussionState(value), subagent }
  } catch {
    return { kind: 'invalid' }
  }
}

export function decodeLiveState(value: unknown): DiscussionState | undefined {
  const classified = classifyLivePayload(value)
  return classified.kind === 'state' ? classified.state : undefined
}

export interface LiveDiscussionSnapshot {
  readonly sessionId: string
  readonly state?: DiscussionState
  readonly subagent?: SubagentRailStatus
}

/** Apply an SSE payload. Decode failure keeps the previous frame. */
export function applyLivePayload(
  current: LiveDiscussionSnapshot,
  sessionId: string,
  value: unknown,
): LiveDiscussionSnapshot {
  const classified = classifyLivePayload(value)
  if (classified.kind === 'invalid') {
    return current.sessionId === sessionId ? current : { sessionId }
  }
  if (classified.kind === 'inactive') return { sessionId }
  const previous = current.sessionId === sessionId ? current.state : undefined
  if (previous !== undefined && classified.state.revision < previous.revision) return current
  return liveSnapshot(sessionId, classified.state, classified.subagent)
}

/** GET /state fallback: seed a valid snapshot only; never wipe a live frame. */
export function applyStateFallback(
  current: LiveDiscussionSnapshot,
  sessionId: string,
  value: unknown,
): LiveDiscussionSnapshot {
  const classified = classifyLivePayload(value)
  if (classified.kind !== 'state') return current.sessionId === sessionId ? current : { sessionId }
  return applyLivePayload(current, sessionId, value)
}

/** Never show a snapshot that belongs to a previously selected session. */
export function visibleLiveState(
  snapshot: LiveDiscussionSnapshot,
  sessionId: string | undefined,
): DiscussionState | undefined {
  return visibleLiveSnapshot(snapshot, sessionId)?.state
}

export function visibleLiveSnapshot(
  snapshot: LiveDiscussionSnapshot,
  sessionId: string | undefined,
): LiveDiscussionSnapshot | undefined {
  return sessionId !== undefined && snapshot.sessionId === sessionId ? snapshot : undefined
}

/**
 * Live Discussion state for one session via the plugin's SSE endpoint. The
 * browser reconnects automatically after a DSH restart, and the host pushes
 * the current state on (re)connect, so the Rail restores without user action.
 */
export function useDiscussionLive(sessionId: string | undefined): {
  readonly state: DiscussionState | undefined
  readonly subagent: SubagentRailStatus | undefined
} {
  const [snapshot, setSnapshot] = useState<LiveDiscussionSnapshot>({ sessionId: '' })
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return undefined
    let cancelled = false
    const apply = (
      value: unknown,
      reducer: typeof applyLivePayload,
    ) => {
      if (cancelled) return
      setSnapshot(current => reducer(current, sessionId, value))
    }
    void fetch(discussionIntentStatePath(sessionId), { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) return undefined
        return response.json() as Promise<unknown>
      })
      .then(value => {
        if (value !== undefined) apply(value, applyStateFallback)
      })
      .catch(() => undefined)
    const source = new EventSource(`/dsh/discussion-intent/events?sessionId=${encodeURIComponent(sessionId)}`)
    source.onmessage = (message) => {
      let value: unknown
      try {
        value = JSON.parse(String(message.data))
      } catch {
        return
      }
      apply(value, applyLivePayload)
    }
    return () => {
      cancelled = true
      source.close()
    }
  }, [sessionId])
  const visible = visibleLiveSnapshot(snapshot, sessionId)
  return { state: visible?.state, subagent: visible?.subagent }
}

export function useDiscussionState(sessionId: string | undefined): DiscussionState | undefined {
  return useDiscussionLive(sessionId).state
}

export type DiscussionRailDockProps = import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'> & PropsLocale<'discussionIntent'>

export function DiscussionRailDock({ sessionId, t }: DiscussionRailDockProps) {
  const live = useDiscussionLive(sessionId)
  return live.subagent === undefined
    ? <InteractiveDiscussionRail state={live.state} t={t} />
    : <InteractiveDiscussionRail state={live.state} subagent={live.subagent} t={t} />
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('discussionIntent', { zh, en }), 'discussion-intent:locale')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'discussion-intent-rail',
    order: 15,
    locale: 'discussionIntent',
  }, DiscussionRailDock))
}
