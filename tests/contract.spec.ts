import { describe, expect, it } from 'vitest'
import {
  createDiscussionIntent,
  proposeFrameChange,
  resolvePendingFrameChange,
  setFocus,
  type SourceAttestation,
} from '../src/contract.ts'

const source = (eventId: string, quote = 'Keep the scope narrow.'): SourceAttestation => ({
  sourceEventId: eventId,
  quotedText: quote,
})

describe('Discussion Intent contract', () => {
  it('keeps a proposed frame separate from the authoritative human frame', () => {
    const proposed = proposeFrameChange(createDiscussionIntent(), {
      id: 'frame-1', proposedText: 'Build a standalone plugin.', source: source('user-1'),
    })
    expect(proposed).toEqual({
      revision: 1,
      pendingFrameChange: {
        id: 'frame-1', proposedText: 'Build a standalone plugin.',
        source: source('user-1'), proposedAtRevision: 0,
      },
    })
  })

  it('requires a pending change to be resolved before another is proposed', () => {
    const proposed = proposeFrameChange(createDiscussionIntent(), {
      id: 'frame-1', proposedText: 'One change.', source: source('user-1'),
    })
    expect(() => proposeFrameChange(proposed, {
      id: 'frame-2', proposedText: 'A competing change.', source: source('user-2'),
    })).toThrow('pending frame change')
  })

  it('acceptance turns pending text into an attested human frame', () => {
    const proposed = proposeFrameChange(createDiscussionIntent(), {
      id: 'frame-1', proposedText: 'Own a separate GitHub project.', source: source('user-1'),
    })
    const accepted = resolvePendingFrameChange(proposed, {
      kind: 'accepted', source: source('user-2', 'Yes, owner is JinPLu.'),
    })
    expect(accepted).toEqual({
      revision: 2,
      humanFrame: {
        source: source('user-2', 'Yes, owner is JinPLu.'), text: 'Own a separate GitHub project.',
      },
      pendingFrameChange: undefined,
    })
  })

  it('rejection preserves the prior human frame', () => {
    const withFrame = resolvePendingFrameChange(proposeFrameChange(createDiscussionIntent(), {
      id: 'frame-1', proposedText: 'Original frame.', source: source('user-1'),
    }), { kind: 'accepted', source: source('user-2') })
    const nextProposal = proposeFrameChange(withFrame, {
      id: 'frame-2', proposedText: 'Replacement frame.', source: source('user-3'),
    })
    const rejected = resolvePendingFrameChange(nextProposal, {
      kind: 'rejected', source: source('user-4'),
    })
    expect(rejected.humanFrame?.text).toBe('Original frame.')
    expect(rejected.pendingFrameChange).toBeUndefined()
    expect(rejected.revision).toBe(4)
  })

  it('rejects empty attestations and advances focus revisions', () => {
    expect(() => proposeFrameChange(createDiscussionIntent(), {
      id: 'frame-1', proposedText: 'A valid proposal.', source: source(''),
    })).toThrow('Source event id')
    expect(setFocus(createDiscussionIntent(), 'Plugin extraction').revision).toBe(1)
  })
})
