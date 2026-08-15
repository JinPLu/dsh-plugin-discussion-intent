/**
 * Discussion Intent — public package entry.
 *
 * Thin facade: all DSH host imports and host wiring live behind the single
 * named adapter boundary in `dsh-adapter.ts`. Re-exporting from here keeps
 * the public API and package entry behavior unchanged.
 */
export {
  apply,
  Config,
  DiscussionIntentController,
  inject,
  name,
} from './dsh-adapter.ts'
export { DISCUSSION_CAPABILITY_MANIFEST } from './capabilities.ts'
export type {
  DiscussionCapability,
  DiscussionCapabilityId,
  DiscussionCapabilityManifest,
} from './capabilities.ts'
