/**
 * Transport-independent Discussion Intent domain contract.
 *
 * DSH adapters must supply attested user-source data and CAS-backed revision
 * writes. This module deliberately has no DSH imports so it can be tested and
 * reviewed independently of a host release.
 */

export type Revision = number

export interface SourceAttestation {
  /** Stable core-issued identity for the direct user message. */
  readonly sourceEventId: string
  /** Exact text rendered to a reviewer; this plugin never claims to verify it. */
  readonly quotedText: string
}

export interface HumanFrame {
  readonly source: SourceAttestation
  readonly text: string
}

export interface PendingFrameChange {
  readonly id: string
  readonly proposedText: string
  readonly source: SourceAttestation
  readonly proposedAtRevision: Revision
}

export interface DiscussionIntent {
  readonly revision: Revision
  readonly focus?: string
  readonly workingItem?: string
  readonly humanFrame?: HumanFrame
  readonly pendingFrameChange?: PendingFrameChange
}

export interface ProposeFrameChangeInput {
  readonly id: string
  readonly proposedText: string
  readonly source: SourceAttestation
}

export type FrameChangeResolution =
  | { readonly kind: 'accepted'; readonly source: SourceAttestation }
  | { readonly kind: 'rejected'; readonly source: SourceAttestation }

/** Create the empty, revision-zero discussion intent. */
export function createDiscussionIntent(): DiscussionIntent {
  return { revision: 0 }
}

/** Add a reviewable pending change without changing the authoritative frame. */
export function proposeFrameChange(intent: DiscussionIntent, input: ProposeFrameChangeInput): DiscussionIntent {
  if (intent.pendingFrameChange !== undefined) {
    throw new Error('A pending frame change must be resolved before proposing another.')
  }
  assertNonEmpty(input.id, 'Pending frame change id')
  assertNonEmpty(input.proposedText, 'Proposed frame text')
  assertAttestation(input.source)
  return {
    ...intent,
    revision: intent.revision + 1,
    pendingFrameChange: { ...input, proposedAtRevision: intent.revision },
  }
}

/**
 * Resolve the pending change. Acceptance makes its text the Human Frame;
 * rejection preserves the prior frame. Both actions consume attested user data.
 */
export function resolvePendingFrameChange(intent: DiscussionIntent, resolution: FrameChangeResolution): DiscussionIntent {
  const pending = intent.pendingFrameChange
  if (pending === undefined) throw new Error('There is no pending frame change to resolve.')
  assertAttestation(resolution.source)
  if (resolution.kind === 'rejected') {
    const { pendingFrameChange: _pendingFrameChange, ...withoutPending } = intent
    return { ...withoutPending, revision: intent.revision + 1 }
  }
  const { pendingFrameChange: _pendingFrameChange, ...withoutPending } = intent
  return {
    ...withoutPending,
    revision: intent.revision + 1,
    humanFrame: { source: resolution.source, text: pending.proposedText },
  }
}

/** Set an optional focus value and advance the semantic revision. */
export function setFocus(intent: DiscussionIntent, focus: string | undefined): DiscussionIntent {
  if (focus === undefined) {
    const { focus: _focus, ...withoutFocus } = intent
    return { ...withoutFocus, revision: intent.revision + 1 }
  }
  assertNonEmpty(focus, 'Focus')
  return { ...intent, revision: intent.revision + 1, focus }
}

function assertAttestation(source: SourceAttestation): void {
  assertNonEmpty(source.sourceEventId, 'Source event id')
  assertNonEmpty(source.quotedText, 'Source quote')
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty.`)
}
