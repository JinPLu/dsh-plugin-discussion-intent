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
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  assertDiscussionState,
  renderDiscussionMarkdown,
  withCheckpoint,
  type DiscussionState,
} from './contract.ts'

export const DEFAULT_DIRECTORY = '.dsh/discussions'

export function discussionDirectory(cwd: string, directory: string): string {
  return resolve(cwd, directory)
}

/** Absolute path of the authoritative JSON state sidecar. */
export function discussionStateJsonPath(cwd: string, directory: string, sessionId: string): string {
  return resolve(discussionDirectory(cwd, directory), `${sessionId}.json`)
}

/** Absolute path of the human-readable Markdown checkpoint. */
export function discussionMarkdownPath(cwd: string, directory: string, sessionId: string): string {
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
    assertDiscussionState(value)
  } catch (cause: unknown) {
    throw new Error(
      `Discussion sidecar ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)} Delete the file to reset Discussion Mode.`,
      { cause },
    )
  }
  return value
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
    assertDiscussionState(value)
  } catch (cause: unknown) {
    throw new Error(
      `Discussion sidecar ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)} Delete the file to reset Discussion Mode.`,
      { cause },
    )
  }
  return value
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
 * discussion usable without silently pretending it was persisted.
 */
export async function writeDiscussionSidecar(
  cwd: string,
  directory: string,
  sessionId: string,
  state: DiscussionState,
): Promise<DiscussionState> {
  const jsonPath = discussionStateJsonPath(cwd, directory, sessionId)
  const markdownPath = discussionMarkdownPath(cwd, directory, sessionId)
  const temporaryJson = temporaryPath(jsonPath)
  const temporaryMarkdown = temporaryPath(markdownPath)
  const saved = withCheckpoint(state, { status: 'saved', filePath: markdownPath })
  try {
    await mkdir(discussionDirectory(cwd, directory), { recursive: true })
    await writeFile(temporaryMarkdown, renderDiscussionMarkdown(saved), 'utf8')
    await writeFile(temporaryJson, `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
    await rename(temporaryMarkdown, markdownPath)
    await rename(temporaryJson, jsonPath)
    return saved
  } catch (error: unknown) {
    await unlink(temporaryMarkdown).catch(() => undefined)
    await unlink(temporaryJson).catch(() => undefined)
    return withCheckpoint(state, {
      status: 'error',
      filePath: markdownPath,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
