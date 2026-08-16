/**
 * Discussion Intent — web client package entry.
 *
 * Thin facade: all DSH client imports and host-facing wiring live behind the
 * named client adapter boundary in `dsh-adapter.tsx`. Re-exporting from here
 * keeps the public API and package entry behavior unchanged.
 */
export {
  apply,
  applyLivePayload,
  applyStateFallback,
  classifyLivePayload,
  DISCUSSION_INTENT_MODELS_PATH,
  DISCUSSION_INTENT_STATE_PATH,
  DISCUSSION_INTENT_SUBAGENT_PATH,
  DiscussionRail,
  DiscussionRailDock,
  decodeLiveState,
  discussionIntentStatePath,
  fetchSubagentCatalog,
  compactRailText,
  formatLocalizedSubagentRailStatus,
  HIDE_GOAL_BAR_CSS,
  inject,
  name,
  postSubagentRoute,
  railHeaderNarrative,
  railValueStyle,
  toggleExpandedRailRow,
  useDiscussionLive,
  useDiscussionState,
  visibleLiveSnapshot,
  visibleLiveState,
} from './dsh-adapter.tsx'
export type {
  ClassifiedLivePayload,
  DiscussionRailDockProps,
  DiscussionRailProps,
  LiveDiscussionSnapshot,
} from './dsh-adapter.tsx'
