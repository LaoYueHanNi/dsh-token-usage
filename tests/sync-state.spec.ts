import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completedFieldIds, isInitialized, markFieldCompletionOutcome, markInitialized, markMetaSynced, markTimingSynced, pendingCompleterIds } from '../src/sync-state.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'token-usage-state-'))
}

describe('isInitialized', () => {
  it('reads absent as uninitialized', async () => {
    expect(await isInitialized(await tempDir())).toBe(false)
  })

  it('reads a valid marker as initialized', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1_700_000_000_000))
    expect(await isInitialized(dir)).toBe(true)
  })

  it('treats malformed JSON as uninitialized', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), '{broken')
    expect(await isInitialized(dir)).toBe(false)
  })

  it('treats a non-state object as uninitialized', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ other: 1 }))
    expect(await isInitialized(dir)).toBe(false)
  })
})

describe('markInitialized', () => {
  it('writes the marker and leaves no temp file behind', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1_700_000_000_000))
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ initializedAt: 1_700_000_000_000 })
    await expect(readFile(join(dir, 'state.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('metaSyncedAt markers', () => {
  it('markInitialized(withMeta) writes both markers together', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1_700_000_000_000), true)
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ initializedAt: 1_700_000_000_000, metaSyncedAt: 1_700_000_000_000 })
  })

  it('markInitialized without withMeta omits the meta marker', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1_700_000_000_000))
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ initializedAt: 1_700_000_000_000 })
  })

  it('markInitialized preserves an existing metaSyncedAt', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ initializedAt: 1, metaSyncedAt: 2 }))
    await markInitialized(dir, () => new Date(3))
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ initializedAt: 3, metaSyncedAt: 2 })
  })

  it('markMetaSynced stamps the backfill and preserves initializedAt', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ initializedAt: 1 }))
    await markMetaSynced(dir, () => new Date(9))
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ initializedAt: 1, metaSyncedAt: 9 })
  })
})

describe('timingSyncedAt markers', () => {
  it('markInitialized(withMeta, withTiming) writes all markers together', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1_700_000_000_000), true, true)
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({
      initializedAt: 1_700_000_000_000,
      metaSyncedAt: 1_700_000_000_000,
      timingSyncedAt: 1_700_000_000_000,
    })
  })

  it('markTimingSynced stamps the backfill and preserves existing markers', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ initializedAt: 1, metaSyncedAt: 2 }))
    await markTimingSynced(dir, () => new Date(9))
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ initializedAt: 1, metaSyncedAt: 2, timingSyncedAt: 9 })
  })
})

describe('completedFields', () => {
  it('stamps a clean pass, clears its retries, and survives the other marker writes', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1), true, true)
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      initializedAt: 1, metaSyncedAt: 1, timingSyncedAt: 1,
      completedFields: [], fieldCompletionAttempts: { provider: 2 },
    }))
    const settled = await markFieldCompletionOutcome(dir, { cleanIds: ['provider'], retriedIds: [] })
    expect(settled).toEqual(['provider'])
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({
      initializedAt: 1,
      metaSyncedAt: 1,
      timingSyncedAt: 1,
      completedFields: ['provider'],
    })
    await markTimingSynced(dir, () => new Date(9))
    await markMetaSynced(dir, () => new Date(8))
    await markInitialized(dir, () => new Date(4))
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
      initializedAt: number
      metaSyncedAt: number
      timingSyncedAt: number
      completedFields: string[]
      fieldCompletionAttempts?: Record<string, number>
    }
    expect(state.completedFields).toEqual(['provider'])
    expect(state.initializedAt).toBe(4)
    expect(state.fieldCompletionAttempts).toBeUndefined()
    expect(completedFieldIds(state)).toEqual(['provider'])
    expect(pendingCompleterIds(state, ['provider', 'later'])).toEqual(['later'])
  })

  it('counts retried passes and stamps the completer once the budget runs out', async () => {
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1))
    // First unreadable pass: counted, not stamped.
    let settled = await markFieldCompletionOutcome(dir, { cleanIds: [], retriedIds: ['provider'] })
    expect(settled).toEqual([])
    let state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { completedFields?: string[]; fieldCompletionAttempts?: Record<string, number> }
    expect(state.completedFields).toBeUndefined()
    expect(state.fieldCompletionAttempts).toEqual({ provider: 1 })
    // Second unreadable pass: still within budget.
    settled = await markFieldCompletionOutcome(dir, { cleanIds: [], retriedIds: ['provider'] })
    expect(settled).toEqual([])
    state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { completedFields?: string[]; fieldCompletionAttempts?: Record<string, number> }
    expect(state.fieldCompletionAttempts).toEqual({ provider: 2 })
    // Third unreadable pass: budget exhausted — stamped done, counter cleared.
    settled = await markFieldCompletionOutcome(dir, { cleanIds: [], retriedIds: ['provider'] })
    expect(settled).toEqual(['provider'])
    state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { completedFields?: string[]; fieldCompletionAttempts?: Record<string, number> }
    expect(state.completedFields).toEqual(['provider'])
    expect(state.fieldCompletionAttempts).toBeUndefined()
    // Already stamped: a later retried pass neither re-counts nor re-stamps.
    settled = await markFieldCompletionOutcome(dir, { cleanIds: [], retriedIds: ['provider'] })
    expect(settled).toEqual([])
    expect(pendingCompleterIds(state, ['provider'])).toEqual([])
  })

  it('does not invent initializedAt when the marker is missing', async () => {
    const dir = await tempDir()
    const settled = await markFieldCompletionOutcome(dir, { cleanIds: ['provider'], retriedIds: ['other'] })
    expect(settled).toEqual([])
    await expect(readFile(join(dir, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores a malformed done-set and attempt map', async () => {
    expect(completedFieldIds({ initializedAt: 1, completedFields: 'provider' as unknown as string[] })).toEqual([])
    expect(pendingCompleterIds(null, ['provider'])).toEqual(['provider'])
    const dir = await tempDir()
    await markInitialized(dir, () => new Date(1))
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      initializedAt: 1,
      fieldCompletionAttempts: { '': 1, provider: 'x' as unknown as number, other: -2 },
    }))
    const settled = await markFieldCompletionOutcome(dir, { cleanIds: [], retriedIds: ['provider'] })
    expect(settled).toEqual([])
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { fieldCompletionAttempts?: Record<string, number> }
    expect(state.fieldCompletionAttempts).toEqual({ provider: 1 })
  })
})
