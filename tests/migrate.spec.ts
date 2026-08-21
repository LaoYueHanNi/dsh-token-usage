/**
 * Two-phase data-directory migration tests: files copy verbatim with size
 * verification, the target's same-named file wins, a copy failure aborts
 * with the source intact, and cleanup removes only files that verifiably
 * landed (same name, same size) plus the emptied directory.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanSource, copyData, type MigrationProgress } from '../src/migrate.ts'

let oldDir: string
let newDir: string

beforeEach(async () => {
  oldDir = await mkdtemp(join(tmpdir(), 'token-usage-mig-old-'))
  newDir = await mkdtemp(join(tmpdir(), 'token-usage-mig-new-'))
})

describe('copyData', () => {
  it('copies every owned file verbatim and reports per-file progress', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\nb\n')
    await writeFile(join(oldDir, 'usage-2026-01-16.jsonl'), 'c\n')
    await writeFile(join(oldDir, 'state.json'), '{"initializedAt":1}')
    await writeFile(join(oldDir, 'pricing.json'), '{"deepseek-chat":{}}')
    await writeFile(join(oldDir, 'pricing.ccsa.json'), '{"version":4}')
    await writeFile(join(oldDir, 'rollup.json'), '{"upto":"2026-01-14"}')

    const seen: MigrationProgress[] = []
    const copied = await copyData(oldDir, newDir, p => { seen.push(p) })

    // The rollup is derived state: it stays behind (the source cleanup drops
    // it) instead of traveling, and the target rebuilds it on first read.
    expect(copied).toHaveLength(5)
    expect(await readFile(join(newDir, 'usage-2026-01-15.jsonl'), 'utf8')).toBe('a\nb\n')
    expect(await readFile(join(newDir, 'state.json'), 'utf8')).toBe('{"initializedAt":1}')
    // Day files keep their per-day names: nothing is re-bucketed.
    expect(existsSync(join(newDir, 'usage-2026-01-16.jsonl'))).toBe(true)
    // Monotone per-file progress over the copying phase.
    expect(seen.at(-1)).toMatchObject({ done: 5, total: 5, phase: 'copying' })
    expect(seen.every(step => step.phase === 'copying')).toBe(true)
    // The source is untouched by the copy phase.
    expect(await readFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'utf8')).toBe('a\nb\n')
  })

  it('drops a stale rollup sitting in the target directory', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\n')
    await writeFile(join(newDir, 'rollup.json'), '{"upto":"2025-12-31"}')

    await copyData(oldDir, newDir)

    // A stale aggregate would serve wrong totals until its lazy rebuild;
    // removing it makes the first stats read rebuild from the copied days.
    expect(existsSync(join(newDir, 'rollup.json'))).toBe(false)
  })

  it('leaves a target-side same-named file alone and counts it as settled', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'old content\n')
    await writeFile(join(newDir, 'usage-2026-01-15.jsonl'), 'live content\n')

    const copied = await copyData(oldDir, newDir)

    expect(copied).toEqual(['usage-2026-01-15.jsonl'])
    expect(await readFile(join(newDir, 'usage-2026-01-15.jsonl'), 'utf8')).toBe('live content\n')
  })

  it('ignores files the plugin does not own', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\n')
    await writeFile(join(oldDir, 'notes.txt'), 'user data')

    const copied = await copyData(oldDir, newDir)

    expect(copied).toEqual(['usage-2026-01-15.jsonl'])
    expect(existsSync(join(newDir, 'notes.txt'))).toBe(false)
  })

  it('aborts on a failed copy with the source fully intact', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\n')
    await writeFile(join(oldDir, 'usage-2026-01-16.jsonl'), 'c\n')
    // Real failure injection: a regular file where the target directory
    // must be, so the target mkdir/copy refuses.
    const { rm } = await import('node:fs/promises')
    await rm(newDir, { recursive: true })
    await writeFile(newDir, 'not a directory')

    await expect(copyData(oldDir, newDir)).rejects.toThrow()
    // The source kept everything.
    expect(existsSync(join(oldDir, 'usage-2026-01-15.jsonl'))).toBe(true)
    expect(existsSync(join(oldDir, 'usage-2026-01-16.jsonl'))).toBe(true)
  })

  it('is a no-op when the source directory does not exist', async () => {
    const copied = await copyData(join(oldDir, 'missing'), newDir)
    expect(copied).toEqual([])
    expect((await readdir(newDir)).length).toBe(0)
  })
})

describe('cleanSource', () => {
  it('removes files that verifiably landed, the source rollup, and the emptied directory', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\n')
    await writeFile(join(oldDir, 'rollup.json'), '{"upto":"2026-01-15"}')
    await copyData(oldDir, newDir)

    const seen: MigrationProgress[] = []
    const result = await cleanSource(oldDir, newDir, p => { seen.push(p) })

    expect(result).toMatchObject({ cleaned: 1 })
    expect(existsSync(join(oldDir, 'usage-2026-01-15.jsonl'))).toBe(false)
    // The derived rollup leaves with the directory so the source can go.
    expect(existsSync(join(oldDir, 'rollup.json'))).toBe(false)
    expect(existsSync(oldDir)).toBe(false)
    expect(seen.at(-1)).toMatchObject({ done: 1, total: 1, phase: 'cleaning' })
  })

  it('keeps a source file whose copy is missing in the target', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\n')
    await writeFile(join(oldDir, 'usage-2026-01-16.jsonl'), 'c\n')
    // Only one file was copied (the second failed and aborted).
    await copyFileSafe(join(oldDir, 'usage-2026-01-15.jsonl'), join(newDir, 'usage-2026-01-15.jsonl'))

    await cleanSource(oldDir, newDir)

    expect(existsSync(join(oldDir, 'usage-2026-01-15.jsonl'))).toBe(false)
    expect(existsSync(join(oldDir, 'usage-2026-01-16.jsonl'))).toBe(true)
    expect(existsSync(oldDir)).toBe(true)
  })

  it('keeps a source file whose landed copy has a different size', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\nb\nc\n')
    // A torn or diverged target copy must not authorize the delete.
    await writeFile(join(newDir, 'usage-2026-01-15.jsonl'), 'a\n')

    await cleanSource(oldDir, newDir)

    expect(existsSync(join(oldDir, 'usage-2026-01-15.jsonl'))).toBe(true)
  })

  it('keeps the directory when an unknown file remains', async () => {
    await writeFile(join(oldDir, 'usage-2026-01-15.jsonl'), 'a\n')
    await writeFile(join(oldDir, 'user-notes.txt'), 'keep me')
    await copyData(oldDir, newDir)

    await cleanSource(oldDir, newDir)

    expect(existsSync(join(oldDir, 'usage-2026-01-15.jsonl'))).toBe(false)
    expect(existsSync(join(oldDir, 'user-notes.txt'))).toBe(true)
    expect(existsSync(oldDir)).toBe(true)
  })
})

/** Plain copy used by the cleanup tests to stage a landed file. */
async function copyFileSafe(source: string, destination: string): Promise<void> {
  const { copyFile } = await import('node:fs/promises')
  await copyFile(source, destination)
}
