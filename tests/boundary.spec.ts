import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))

/**
 * The single named adapter boundary: only these source files may reference
 * DSH packages. Everything else under `src` (contract, sidecar, capabilities,
 * and the thin entry facades) must stay DSH-independent. Test files are
 * intentionally out of scope: they compose the real DSH host by design.
 */
const ALLOWED_ADAPTERS: readonly string[] = [
  join(SRC_ROOT, 'dsh-adapter.ts'),
  join(SRC_ROOT, 'dsh-invariant-adapter.ts'),
  join(SRC_ROOT, 'client', 'dsh-adapter.tsx'),
]

const DSH_REFERENCE = /['"]@deepseek-ai\/[^'"]*['"]/u

function sourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
}

describe('DSH host adapter boundary', () => {
  it('keeps every DSH package reference inside the named adapter files', () => {
    const offenders = sourceFiles().filter(file =>
      !ALLOWED_ADAPTERS.includes(file) && DSH_REFERENCE.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('has exactly the named adapters as the DSH import boundary', () => {
    const adapters = sourceFiles().filter(file => DSH_REFERENCE.test(readFileSync(file, 'utf8')))
    expect(adapters.sort()).toEqual([...ALLOWED_ADAPTERS].sort())
  })

  it('keeps the package entry files as thin, DSH-free facades', () => {
    for (const entry of ['index.ts', 'invariant.ts', join('client', 'index.tsx')]) {
      const text = readFileSync(join(SRC_ROOT, entry), 'utf8')
      expect(text).toMatch(/\bexport\b[\s\S]*\bfrom\s+['"]\.\//u)
      expect(text).not.toMatch(DSH_REFERENCE)
    }
  })
})
