import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSyncProgress, writeSyncProgress, type SyncProgress } from '../src/sync-state.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'token-usage-state-'))
}

describe('readSyncProgress', () => {
  it('reads an absent marker as an empty v2 progress map', async () => {
    const progress = await readSyncProgress(await tempDir())
    expect(progress).toEqual({ version: 2, sessions: {} })
  })

  it('reads a valid v2 marker verbatim', async () => {
    const dir = await tempDir()
    const written: SyncProgress = {
      version: 2,
      syncedAt: 1_700_000_000_000,
      sessions: { 's1': { lastSyncedSeq: 42 }, 's2': { lastSyncedSeq: 7 } },
    }
    await writeSyncProgress(dir, written)
    expect(await readSyncProgress(dir)).toEqual(written)
  })

  it('treats v1 initializedAt as an empty v2 progress map', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ initializedAt: 1_700_000_000_000 }))
    expect(await readSyncProgress(dir)).toEqual({ version: 2, sessions: {} })
  })

  it('treats malformed JSON as an empty v2 progress map', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), '{broken')
    expect(await readSyncProgress(dir)).toEqual({ version: 2, sessions: {} })
  })

  it('treats an unrelated object as an empty v2 progress map', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ other: 1 }))
    expect(await readSyncProgress(dir)).toEqual({ version: 2, sessions: {} })
  })

  it('treats a v2 object with a malformed session entry as an empty v2 progress map', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 2, sessions: { s1: { lastSyncedSeq: 'oops' } } }))
    expect(await readSyncProgress(dir)).toEqual({ version: 2, sessions: {} })
  })
})

describe('writeSyncProgress', () => {
  it('writes the marker and leaves no temp file behind', async () => {
    const dir = await tempDir()
    const progress: SyncProgress = {
      version: 2,
      syncedAt: 1_700_000_000_000,
      sessions: { 's1': { lastSyncedSeq: 42 } },
    }
    await writeSyncProgress(dir, progress)
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual(progress)
    await expect(readFile(join(dir, 'state.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('omits syncedAt when not provided', async () => {
    const dir = await tempDir()
    await writeSyncProgress(dir, { version: 2, sessions: {} })
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(parsed.syncedAt).toBeUndefined()
    expect(parsed.sessions).toEqual({})
    expect(parsed.version).toBe(2)
  })
})