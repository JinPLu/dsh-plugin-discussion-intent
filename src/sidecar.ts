/**
 * Plugin-owned durable Discussion sidecar.
 *
 * The DSH session log is never modified: Discussion Mode keeps its state in a
 * private JSON sidecar plus a readable Markdown checkpoint, both keyed by
 * (session id, session workspace) and written atomically before any
 * substantive step proceeds. Every consumer (slash command, tool,
 * system-prompt policy, Web Rail transport) loads the current state from the
 * sidecar on demand, so a full DSH exit/restart/reopen restores the discussion
 * exactly.
 *
 * Storage is strictly workspace-scoped. `directory` must be workspace-relative
 * and its normalized form must stay inside the session workspace (absolute
 * paths and `..` escapes are rejected), and `sessionId` must be a plain
 * filename-safe identifier, so the JSON/Markdown files can never escape the
 * discussion directory.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  decodeDiscussionState,
  renderDiscussionMarkdown,
  withCheckpoint,
  type DiscussionState,
} from './contract.ts'

export const DEFAULT_DIRECTORY = '.dsh/discussions'

/** Filename-safe session ids: plain ids starting with a letter or digit. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Invalid Discussion session id ${JSON.stringify(sessionId)}: expected a filename-safe id containing only letters, digits, '.', '_', and '-'.`,
    )
  }
}

function assertWorkspaceRelativeDirectory(cwd: string, directory: string): void {
  const trimmed = directory.trim()
  if (trimmed === '') throw new Error('Discussion sidecar directory must not be empty.')
  if (isAbsolute(trimmed)) {
    throw new Error(`Discussion sidecar directory must be workspace-relative, but ${JSON.stringify(trimmed)} is absolute.`)
  }
  const workspace = resolve(cwd)
  const target = resolve(workspace, trimmed)
  const inside = relative(workspace, target)
  if (inside !== '' && (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))) {
    throw new Error(
      `Discussion sidecar directory must resolve inside the session workspace, but ${JSON.stringify(trimmed)} resolves to ${JSON.stringify(target)}.`,
    )
  }
}

export function discussionDirectory(cwd: string, directory: string): string {
  assertWorkspaceRelativeDirectory(cwd, directory)
  return resolve(cwd, directory.trim())
}

/** Absolute path of the authoritative JSON state sidecar. */
export function discussionStateJsonPath(cwd: string, directory: string, sessionId: string): string {
  assertSessionId(sessionId)
  return resolve(discussionDirectory(cwd, directory), `${sessionId}.json`)
}

/** Absolute path of the human-readable Markdown checkpoint. */
export function discussionMarkdownPath(cwd: string, directory: string, sessionId: string): string {
  assertSessionId(sessionId)
  return resolve(discussionDirectory(cwd, directory), `${sessionId}.md`)
}

function temporaryPath(target: string): string {
  return resolve(dirname(target), `.${basename(target)}.${String(process.pid)}.${String(Date.now())}.tmp`)
}

/** Read and validate the sidecar state; `undefined` when no discussion exists yet. */
export async function readDiscussionSidecar(
  cwd: string,
  directory: string,
  sessionId: string,
): Promise<DiscussionState | undefined> {
  const path = discussionStateJsonPath(cwd, directory, sessionId)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause: unknown) {
    throw new Error(`Discussion sidecar ${path} is not valid JSON. Delete the file to reset Discussion Mode.`, { cause })
  }
  try {
    return decodeDiscussionState(value)
  } catch (cause: unknown) {
    throw new Error(
      `Discussion sidecar ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)} Delete the file to reset Discussion Mode.`,
      { cause },
    )
  }
}

/** File mtime revision of the sidecar, for freshness checks without parsing. */
export async function discussionSidecarRevision(
  cwd: string,
  directory: string,
  sessionId: string,
): Promise<number | undefined> {
  try {
    return (await stat(discussionStateJsonPath(cwd, directory, sessionId))).mtimeMs
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Synchronous sidecar read for the synchronous system-prompt/command load paths. */
export function readDiscussionSidecarSync(
  cwd: string,
  directory: string,
  sessionId: string,
): DiscussionState | undefined {
  const path = discussionStateJsonPath(cwd, directory, sessionId)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause: unknown) {
    throw new Error(`Discussion sidecar ${path} is not valid JSON. Delete the file to reset Discussion Mode.`, { cause })
  }
  try {
    return decodeDiscussionState(value)
  } catch (cause: unknown) {
    throw new Error(
      `Discussion sidecar ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)} Delete the file to reset Discussion Mode.`,
      { cause },
    )
  }
}

/** Synchronous sidecar mtime revision for freshness checks. */
export function discussionSidecarRevisionSync(
  cwd: string,
  directory: string,
  sessionId: string,
): number | undefined {
  try {
    return statSync(discussionStateJsonPath(cwd, directory, sessionId)).mtimeMs
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Atomically persist the Markdown checkpoint first (the user-visible artifact),
 * then the authoritative JSON sidecar. Returns the state with its checkpoint
 * updated: `saved` points at the Markdown file; `error` keeps the in-memory
 * discussion usable without silently pretending it was persisted. Path
 * validation failures (unsafe directory or session id) are reported through
 * the same checkpoint error channel as any other write failure.
 */
export async function writeDiscussionSidecar(
  cwd: string,
  directory: string,
  sessionId: string,
  state: DiscussionState,
): Promise<DiscussionState> {
  let markdownPath: string | undefined
  let temporaryJson: string | undefined
  let temporaryMarkdown: string | undefined
  try {
    const jsonPath = discussionStateJsonPath(cwd, directory, sessionId)
    markdownPath = discussionMarkdownPath(cwd, directory, sessionId)
    temporaryJson = temporaryPath(jsonPath)
    temporaryMarkdown = temporaryPath(markdownPath)
    const saved = withCheckpoint(state, { status: 'saved', filePath: markdownPath })
    await mkdir(discussionDirectory(cwd, directory), { recursive: true })
    await writeFile(temporaryMarkdown, renderDiscussionMarkdown(saved), 'utf8')
    await writeFile(temporaryJson, `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
    await rename(temporaryMarkdown, markdownPath)
    await rename(temporaryJson, jsonPath)
    return saved
  } catch (error: unknown) {
    if (temporaryMarkdown !== undefined) await unlink(temporaryMarkdown).catch(() => undefined)
    if (temporaryJson !== undefined) await unlink(temporaryJson).catch(() => undefined)
    return withCheckpoint(state, {
      status: 'error',
      ...(markdownPath === undefined ? {} : { filePath: markdownPath }),
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
