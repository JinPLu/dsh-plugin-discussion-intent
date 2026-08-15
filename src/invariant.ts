/**
 * Discussion Intent — invariant-checker package entry.
 *
 * Thin facade: the DSH-specific invariant wiring lives behind the named
 * adapter boundary in `dsh-invariant-adapter.ts`. The package subpath export
 * behavior is unchanged.
 */
export { apply } from './dsh-invariant-adapter.ts'
