/**
 * Machine-readable, plugin-owned capability declaration.
 *
 * This manifest states exactly which runtime capabilities the Discussion
 * Intent plugin uses today. It is an honest declaration, not an enforcement
 * claim: capability policy can only be enforced by the DSH host, and this
 * module is deliberately DSH-independent so a future host manifest can adopt
 * it without importing anything from this package's runtime wiring.
 */

export const DISCUSSION_CAPABILITY_API_VERSION = 1

export type DiscussionCapabilityId =
  | 'command-registration'
  | 'model-tool-registration'
  | 'active-session-read'
  | 'workspace-scoped-private-storage'
  | 'system-prompt-section'
  | 'web-ui-slot-injection'
  | 'same-origin-state-channel'

export interface DiscussionCapability {
  readonly id: DiscussionCapabilityId
  readonly description: string
}

export interface DiscussionCapabilityManifest {
  /** Manifest schema version; bump only when the declaration shape changes. */
  readonly apiVersion: typeof DISCUSSION_CAPABILITY_API_VERSION
  readonly plugin: string
  /** This package declares its needs only; a future DSH host may enforce them. */
  readonly enforcement: 'declaration-only'
  readonly capabilities: readonly DiscussionCapability[]
}

export const DISCUSSION_CAPABILITY_MANIFEST: DiscussionCapabilityManifest = Object.freeze({
  apiVersion: DISCUSSION_CAPABILITY_API_VERSION,
  plugin: '@jinplu/dsh-plugin-discussion-intent',
  enforcement: 'declaration-only',
  capabilities: Object.freeze([
    Object.freeze({
      id: 'command-registration',
      description: 'Registers the /discussion slash command with the host command runtime.',
    }),
    Object.freeze({
      id: 'model-tool-registration',
      description: 'Registers the discussion_update model tool with the host tool runtime.',
    }),
    Object.freeze({
      id: 'active-session-read',
      description: 'Reads the active session (id and workspace path) to locate and serve plugin state.',
    }),
    Object.freeze({
      id: 'workspace-scoped-private-storage',
      description: 'Writes private JSON and Markdown sidecars strictly inside the session workspace directory.',
    }),
    Object.freeze({
      id: 'system-prompt-section',
      description: 'Adds the discussion-intent policy section to the system prompt.',
    }),
    Object.freeze({
      id: 'web-ui-slot-injection',
      description: 'Injects a Discussion rail into the web conversation input dock slot.',
    }),
    Object.freeze({
      id: 'same-origin-state-channel',
      description: 'Serves live Discussion state over a plugin-owned same-origin HTTP/SSE channel.',
    }),
  ]),
})
