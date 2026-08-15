/** Package-owned invariant entrypoint reserved for the runtime adapter. */
export const name = 'discussion-intent-invariant'

/** No mutable cross-plugin state exists before the runtime adapter is added. */
export function apply(): () => void {
  return () => {}
}
