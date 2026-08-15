/**
 * Discussion Intent — web client package entry.
 *
 * Thin facade: all DSH client imports and host-facing wiring live behind the
 * named client adapter boundary in `dsh-adapter.tsx`. Re-exporting from here
 * keeps the public API and package entry behavior unchanged.
 */
export {
  apply,
  DiscussionRail,
  DiscussionRailDock,
  decodeLiveState,
  inject,
  name,
  useDiscussionState,
  visibleLiveState,
} from './dsh-adapter.tsx'
export type {
  DiscussionRailDockProps,
  DiscussionRailProps,
  LiveDiscussionSnapshot,
} from './dsh-adapter.tsx'
