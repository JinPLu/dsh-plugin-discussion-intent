import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createDiscussionState } from '../src/contract.ts'
import {
  DEFAULT_DIRECTORY,
  discussionDirectory,
  discussionMarkdownPath,
  discussionSidecarRevisionSync,
  discussionStateJsonPath,
  readDiscussionSidecar,
  readDiscussionSidecarSync,
  writeDiscussionSidecar,
} from '../src/sidecar.ts'

describe('workspace-relative sidecar directory', () => {
  it('accepts relative directories and resolves them inside the workspace', () => {
    expect(discussionDirectory('/workspace', '.dsh/discussions')).toBe(resolve('/workspace/.dsh/discussions'))
    expect(discussionDirectory('/workspace', 'checkpoints/deep/nested')).toBe(resolve('/workspace/checkpoints/deep/nested'))
    expect(discussionStateJsonPath('/workspace', 'checkpoints/deep/nested', 'session-1'))
      .toBe(resolve('/workspace/checkpoints/deep/nested/session-1.json'))
    expect(discussionMarkdownPath('/workspace', 'checkpoints/deep/nested', 'session-1'))
      .toBe(resolve('/workspace/checkpoints/deep/nested/session-1.md'))
  })

  it('accepts normalized in-workspace forms like dot segments and the workspace itself', () => {
    expect(discussionDirectory('/workspace', '.')).toBe(resolve('/workspace'))
    expect(discussionDirectory('/workspace', 'a/../b')).toBe(resolve('/workspace/b'))
    expect(discussionDirectory('/workspace', DEFAULT_DIRECTORY)).toBe(resolve('/workspace/.dsh/discussions'))
  })

  it('rejects absolute directories', () => {
    expect(() => discussionDirectory('/workspace', '/elsewhere/checkpoints')).toThrow(/absolute/)
    expect(() => discussionDirectory('/workspace', resolve('/elsewhere/checkpoints'))).toThrow(/absolute/)
    expect(() => discussionStateJsonPath('/workspace', '/etc/dsh', 'session-1')).toThrow(/absolute/)
    expect(() => discussionMarkdownPath('/workspace', '/etc/dsh', 'session-1')).toThrow(/absolute/)
  })

  it('rejects parent escapes and directories that resolve outside the workspace', () => {
    for (const directory of ['..', '../checkpoints', 'a/../../checkpoints', '.dsh/../../../checkpoints']) {
      expect(() => discussionDirectory('/workspace', directory)).toThrow(/inside the session workspace/)
    }
    expect(() => discussionStateJsonPath('/workspace', '../checkpoints', 'session-1')).toThrow(/inside the session workspace/)
    expect(() => discussionMarkdownPath('/workspace', '../checkpoints', 'session-1')).toThrow(/inside the session workspace/)
  })

  it('rejects empty and blank directories', () => {
    expect(() => discussionDirectory('/workspace', '')).toThrow(/must not be empty/)
    expect(() => discussionDirectory('/workspace', '   ')).toThrow(/must not be empty/)
  })
})

describe('filename-safe session ids', () => {
  it('accepts normal session ids, including current plugin usage', () => {
    for (const id of ['discussion-plugin-test', 'discussion-restart-test', 'discussion-consumer-smoke', 'session-1', 'a.b_c-2']) {
      expect(discussionStateJsonPath('/workspace', DEFAULT_DIRECTORY, id))
        .toBe(resolve('/workspace', DEFAULT_DIRECTORY, `${id}.json`))
      expect(discussionMarkdownPath('/workspace', DEFAULT_DIRECTORY, id))
        .toBe(resolve('/workspace', DEFAULT_DIRECTORY, `${id}.md`))
    }
  })

  it('rejects malformed session ids that could escape the discussion directory', () => {
    for (const id of ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'a\0b', '.hidden', 'bad:id', 'has space']) {
      expect(() => discussionStateJsonPath('/workspace', DEFAULT_DIRECTORY, id)).toThrow(/session id/)
      expect(() => discussionMarkdownPath('/workspace', DEFAULT_DIRECTORY, id)).toThrow(/session id/)
    }
  })
})

describe('validation reporting on real reads and writes', () => {
  const temporaryRoots: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discussion-sidecar-'))
    temporaryRoots.push(root)
    return root
  }

  it('read functions report directory and session-id validation errors as ordinary thrown errors', async () => {
    const root = await makeWorkspace()
    const state = createDiscussionState({ id: 'discussion-sidecar-read', intensity: 2, now: 1 })
    const saved = await writeDiscussionSidecar(root, 'checkpoints', 'discussion-sidecar-read', state)
    expect(saved.checkpoint.status).toBe('saved')
    expect(await readDiscussionSidecar(root, 'checkpoints', 'discussion-sidecar-read')).toMatchObject({ revision: 1 })
    expect(readDiscussionSidecarSync(root, 'checkpoints', 'discussion-sidecar-read')).toMatchObject({ revision: 1 })
    await expect(readDiscussionSidecar(root, '../escape', 'discussion-sidecar-read')).rejects.toThrow(/inside the session workspace/)
    await expect(readDiscussionSidecar(root, 'checkpoints', '../escape')).rejects.toThrow(/session id/)
    expect(() => readDiscussionSidecarSync(root, 'checkpoints', 'a/b')).toThrow(/session id/)
  })

  it('write reports directory and session-id validation failures through the checkpoint error channel', async () => {
    const root = await makeWorkspace()
    const state = createDiscussionState({ id: 'discussion-sidecar-write', intensity: 2, now: 1 })

    const escaped = await writeDiscussionSidecar(root, '../escape', 'discussion-sidecar-write', state)
    expect(escaped.checkpoint.status).toBe('error')
    if (escaped.checkpoint.status !== 'error') throw new Error('expected error checkpoint')
    expect(escaped.checkpoint.message).toMatch(/inside the session workspace/)
    expect(escaped.checkpoint.filePath).toBeUndefined()

    const badId = await writeDiscussionSidecar(root, 'checkpoints', '../bad', state)
    expect(badId.checkpoint.status).toBe('error')
    if (badId.checkpoint.status !== 'error') throw new Error('expected error checkpoint')
    expect(badId.checkpoint.message).toMatch(/session id/)
  })

  it('writes and reads through a nested relative directory inside the workspace', async () => {
    const root = await makeWorkspace()
    const state = createDiscussionState({ id: 'discussion-sidecar-nested', intensity: 3, now: 1 })
    const saved = await writeDiscussionSidecar(root, 'checkpoints/deep/nested', 'discussion-sidecar-nested', state)
    expect(saved.checkpoint.status).toBe('saved')
    if (saved.checkpoint.status !== 'saved') throw new Error('expected saved checkpoint')
    expect(saved.checkpoint.filePath).toBe(discussionMarkdownPath(root, 'checkpoints/deep/nested', 'discussion-sidecar-nested'))
    expect(await readFile(discussionStateJsonPath(root, 'checkpoints/deep/nested', 'discussion-sidecar-nested'), 'utf8'))
      .toContain('"discussion-sidecar-nested"')
    expect(await readFile(saved.checkpoint.filePath, 'utf8')).toContain('3=deep')
    expect(await readDiscussionSidecar(root, 'checkpoints/deep/nested', 'discussion-sidecar-nested'))
      .toMatchObject({ id: 'discussion-sidecar-nested' })
    expect(discussionSidecarRevisionSync(root, 'checkpoints/deep/nested', 'discussion-sidecar-nested'))
      .toEqual(expect.any(Number))
  })

  it('decodes an older version-1 sidecar that omitted pendingFrameChanges', async () => {
    const root = await makeWorkspace()
    const state = createDiscussionState({ id: 'discussion-sidecar-legacy', intensity: 2, now: 1 })
    const saved = await writeDiscussionSidecar(root, 'checkpoints', 'discussion-sidecar-legacy', state)
    expect(saved.checkpoint.status).toBe('saved')
    const jsonPath = discussionStateJsonPath(root, 'checkpoints', 'discussion-sidecar-legacy')
    const raw = JSON.parse(await readFile(jsonPath, 'utf8')) as Record<string, unknown>
    delete raw.pendingFrameChanges
    await writeFile(jsonPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    expect(await readDiscussionSidecar(root, 'checkpoints', 'discussion-sidecar-legacy')).toMatchObject({
      id: 'discussion-sidecar-legacy',
      pendingFrameChanges: [],
    })
    expect(readDiscussionSidecarSync(root, 'checkpoints', 'discussion-sidecar-legacy')).toMatchObject({
      pendingFrameChanges: [],
    })
  })

  it('never creates the escape target outside the workspace', async () => {
    const root = await makeWorkspace()
    const escapedTarget = resolve(dirname(root), 'escape')
    expect(() => discussionDirectory(root, '../escape')).toThrow(/inside the session workspace/)
    await expect(stat(escapedTarget)).rejects.toThrow()
  })
})
