import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInitialized, markInitialized } from '../src/sync-state.ts'

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
