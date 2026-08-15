import { describe, expect, it } from 'vitest'
import {
  DISCUSSION_CAPABILITY_API_VERSION,
  DISCUSSION_CAPABILITY_MANIFEST,
  type DiscussionCapabilityId,
} from '../src/capabilities.ts'

const EXPECTED_CAPABILITY_IDS: readonly DiscussionCapabilityId[] = [
  'command-registration',
  'model-tool-registration',
  'active-session-read',
  'workspace-scoped-private-storage',
  'system-prompt-section',
  'web-ui-slot-injection',
  'same-origin-state-channel',
]

describe('Discussion capability manifest', () => {
  it('declares API version 1', () => {
    expect(DISCUSSION_CAPABILITY_API_VERSION).toBe(1)
    expect(DISCUSSION_CAPABILITY_MANIFEST.apiVersion).toBe(1)
  })

  it('pins the public manifest content', () => {
    expect(DISCUSSION_CAPABILITY_MANIFEST).toEqual({
      apiVersion: 1,
      plugin: '@jinplu/dsh-plugin-discussion-intent',
      enforcement: 'declaration-only',
      capabilities: [
        {
          id: 'command-registration',
          description: 'Registers the /discussion slash command with the host command runtime.',
        },
        {
          id: 'model-tool-registration',
          description: 'Registers the discussion_update model tool with the host tool runtime.',
        },
        {
          id: 'active-session-read',
          description: 'Reads the active session (id and workspace path) to locate and serve plugin state.',
        },
        {
          id: 'workspace-scoped-private-storage',
          description: 'Writes private JSON and Markdown sidecars strictly inside the session workspace directory.',
        },
        {
          id: 'system-prompt-section',
          description: 'Adds the discussion-intent policy section to the system prompt.',
        },
        {
          id: 'web-ui-slot-injection',
          description: 'Injects a Discussion rail into the web conversation input dock slot.',
        },
        {
          id: 'same-origin-state-channel',
          description: 'Serves live Discussion state over a plugin-owned same-origin HTTP/SSE channel.',
        },
      ],
    })
  })

  it('declares each capability exactly once, in the pinned order', () => {
    const ids = DISCUSSION_CAPABILITY_MANIFEST.capabilities.map(capability => capability.id)
    expect(ids).toEqual(EXPECTED_CAPABILITY_IDS)
    expect(new Set(ids).size).toBe(EXPECTED_CAPABILITY_IDS.length)
  })

  it('is deeply immutable at runtime', () => {
    expect(Object.isFrozen(DISCUSSION_CAPABILITY_MANIFEST)).toBe(true)
    expect(Object.isFrozen(DISCUSSION_CAPABILITY_MANIFEST.capabilities)).toBe(true)
    for (const capability of DISCUSSION_CAPABILITY_MANIFEST.capabilities) {
      expect(Object.isFrozen(capability)).toBe(true)
    }
  })

  it('claims no current enforcement: a future host may adopt the declaration', () => {
    expect(DISCUSSION_CAPABILITY_MANIFEST.enforcement).toBe('declaration-only')
    expect(Object.keys(DISCUSSION_CAPABILITY_MANIFEST)).toEqual(['apiVersion', 'plugin', 'enforcement', 'capabilities'])
  })
})
