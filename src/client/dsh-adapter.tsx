/**
 * DSH client adapter: the named boundary where the web client imports DSH
 * client packages and wires the host slot/locale services. The client package
 * entry (`index.tsx`) is a thin facade over this module; the rendered rows
 * come from the DSH-independent `contract.ts`.
 */
import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { discussionRailRows, intensityName, type DiscussionState } from '../contract.ts'

export const name = 'discussion-intent-client'
export const inject = ['slots', 'locale']

const zh = {
  title: 'Discussion Mode',
  saved: '已落盘',
  unsaved: '未落盘',
  Focus: '当前焦点',
  You: '你明确说过',
  Understanding: '当前理解',
  Next: '下一步',
} as const

type DiscussionLocaleKey = keyof typeof zh

const en: Record<DiscussionLocaleKey, string> = {
  title: 'Discussion Mode',
  saved: 'saved',
  unsaved: 'not saved',
  Focus: 'Focus',
  You: 'You said',
  Understanding: 'Understanding',
  Next: 'Next',
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
    width: '100%',
    maxWidth: 'calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset))',
    margin: '0 auto',
    padding: '9px 12px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    background: 'var(--dsw-specific-tip)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 5,
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(92px, 128px) minmax(0, 1fr)',
    alignItems: 'baseline',
    gap: 8,
    minHeight: 22,
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
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  modelValue: {
    color: 'var(--dsw-alias-label-primary-dimmed)',
  },
} as const

export interface DiscussionRailProps extends PropsLocale<'discussionIntent'> {
  readonly state: DiscussionState | null | undefined
}

/** Exactly four read-only rows driven only by the plugin-owned Discussion state. */
export function DiscussionRail({ state, t }: DiscussionRailProps) {
  if (state?.active !== true) return null
  const saved = state.checkpoint.status === 'saved'
  return (
    <div style={styles.dock} data-discussion-intent-rail>
      <aside style={styles.rail} aria-label={t('title')}>
        <div style={styles.header}>
          <span>{t('title')} · {String(state.intensity)}={intensityName(state.intensity)}</span>
          <span title={state.checkpoint.status === 'error' ? state.checkpoint.message : undefined}>
            {t(saved ? 'saved' : 'unsaved')}
          </span>
        </div>
        {discussionRailRows(state).map(row => (
          <section key={row.label} style={styles.row} aria-label={t(row.label)}>
            <span style={styles.label}>{t(row.label)}</span>
            <span
              style={row.authority === 'human' ? styles.value : { ...styles.value, ...styles.modelValue }}
              data-authority={row.authority}
              title={row.value}
            >
              {row.value}
            </span>
          </section>
        ))}
      </aside>
    </div>
  )
}

/**
 * Decode one live wire payload. The host stream sends either a whole
 * Discussion state or the `{ active: false }` shorthand meaning "no state".
 * Malformed input yields nothing (the Rail simply stays hidden).
 */
export function decodeLiveState(value: unknown): DiscussionState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { readonly active?: unknown; readonly revision?: unknown }
  if (candidate.active !== true || typeof candidate.revision !== 'number') return undefined
  return value as DiscussionState
}

export interface LiveDiscussionSnapshot {
  readonly sessionId: string
  readonly state?: DiscussionState
}

/** Never show a snapshot that belongs to a previously selected session. */
export function visibleLiveState(
  snapshot: LiveDiscussionSnapshot,
  sessionId: string | undefined,
): DiscussionState | undefined {
  return sessionId !== undefined && snapshot.sessionId === sessionId ? snapshot.state : undefined
}

/**
 * Live Discussion state for one session via the plugin's SSE endpoint. The
 * browser reconnects automatically after a DSH restart, and the host pushes
 * the current state on (re)connect, so the Rail restores without user action.
 */
export function useDiscussionState(sessionId: string | undefined): DiscussionState | undefined {
  const [snapshot, setSnapshot] = useState<LiveDiscussionSnapshot>({ sessionId: '' })
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return undefined
    const source = new EventSource(`/dsh/discussion-intent/events?sessionId=${encodeURIComponent(sessionId)}`)
    let latestRevision = Number.NEGATIVE_INFINITY
    source.onmessage = (message) => {
      let value: unknown
      try {
        value = JSON.parse(String(message.data))
      } catch {
        return
      }
      const incoming = decodeLiveState(value)
      if (incoming === undefined) {
        // "No discussion state" shorthand from the host.
        setSnapshot({ sessionId })
        return
      }
      if (incoming.revision >= latestRevision) {
        latestRevision = incoming.revision
        setSnapshot({ sessionId, state: incoming })
      }
    }
    return () => { source.close() }
  }, [sessionId])
  return visibleLiveState(snapshot, sessionId)
}

export type DiscussionRailDockProps = import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'> & PropsLocale<'discussionIntent'>

export function DiscussionRailDock({ sessionId, t }: DiscussionRailDockProps) {
  const state = useDiscussionState(sessionId)
  return <DiscussionRail state={state} t={t} />
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
