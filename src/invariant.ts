import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_DIRECTORY, readDiscussionSidecar } from './sidecar.ts'

const PACKAGE_NAME = '@jinplu/dsh-plugin-discussion-intent'

/**
 * The Discussion sidecar is the plugin's durable authority. Check every live
 * session's sidecar at boot and whenever a session is created: a malformed
 * sidecar is a real contract violation (not silent degradation), and the
 * failure names the file to delete for a clean reset.
 */
async function validateSidecar(
  ctx: Context,
  session: Session,
  fail: InvariantFailure,
): Promise<void> {
  const cwd = session.header.cwd
  if (cwd === undefined) return
  const controller = ctx.get('discussionIntent') as { readonly directory?: string } | undefined
  const directory = controller?.directory ?? DEFAULT_DIRECTORY
  try {
    await readDiscussionSidecar(cwd, directory, session.id)
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

const install: InvariantInstaller = Object.assign(async (ctx: Context, fail: InvariantFailure) => {
  await Promise.all(ctx.sessions.list().map(session => validateSidecar(ctx, session, fail)))
  ctx.on('session/created', session => {
    void validateSidecar(ctx, session, fail).catch(() => undefined)
  }, { global: true })
}, { inject: ['sessions'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
