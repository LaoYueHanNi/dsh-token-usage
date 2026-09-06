import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionMetaStore } from '../src/session-meta.ts'

function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'token-usage-meta-'))
}

describe('SessionMetaStore', () => {
  it('reads an empty index for a missing file', async () => {
    const store = new SessionMetaStore(await newDir())
    await expect(store.read()).resolves.toEqual({})
  })

  it('upserts entries and persists them atomically (no temp file left)', async () => {
    const dir = await newDir()
    const store = new SessionMetaStore(dir)
    await store.upsert('s1', { title: 'Fix login', cwd: '/work/app' })
    await store.upsert('s2', { cwd: '/work/other', parentSession: 's1', origin: 'subagent' })
    const onDisk = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as Record<string, unknown>
    expect(onDisk.s1).toEqual({ title: 'Fix login', cwd: '/work/app' })
    expect(onDisk.s2).toEqual({ cwd: '/work/other', parentSession: 's1', origin: 'subagent' })
    await expect(readdir(dir)).resolves.not.toContain('sessions.json.tmp')
  })

  it('is idempotent: a no-change upsert does not rewrite the file', async () => {
    const dir = await newDir()
    const store = new SessionMetaStore(dir)
    await store.upsert('s1', { title: 'Fix login' })
    const before = await stat(join(dir, 'sessions.json'))
    // Different mtimeMs resolution can make a rewrite invisible on fast
    // filesystems; the cache hit path is the observable contract here.
    await store.upsert('s1', { title: 'Fix login' })
    const after = await stat(join(dir, 'sessions.json'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('latest-wins on every field per key', async () => {
    const store = new SessionMetaStore(await newDir())
    await store.upsert('s1', { title: 'Draft' })
    await store.upsert('s1', { title: 'Renamed' })
    await store.upsert('s1', { cwd: '/work/app' })
    await expect(store.read()).resolves.toEqual({ s1: { title: 'Renamed', cwd: '/work/app' } })
  })

  it('reads a corrupt file as an empty index (rebuildable cache)', async () => {
    const dir = await newDir()
    await writeFile(join(dir, 'sessions.json'), 'not json {')
    const store = new SessionMetaStore(dir)
    await expect(store.read()).resolves.toEqual({})
    // The next upsert rebuilds the file from the merged (empty) index.
    await store.upsert('s1', { title: 'Rebuilt' })
    await expect(store.read()).resolves.toEqual({ s1: { title: 'Rebuilt' } })
  })

  it('drops unusable rows instead of failing the whole index', async () => {
    const dir = await newDir()
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({
      s1: { title: 'Keep' },
      s2: { title: 42 },
      s3: null,
      '': { title: 'no id' },
    }))
    const store = new SessionMetaStore(dir)
    await expect(store.read()).resolves.toEqual({ s1: { title: 'Keep' } })
  })

  it('reparses when the on-disk stamp changes', async () => {
    const dir = await newDir()
    const store = new SessionMetaStore(dir)
    await store.upsert('s1', { title: 'Cached' })
    await expect(store.read()).resolves.toEqual({ s1: { title: 'Cached' } })
    // An out-of-band rewrite (different size) busts the stamp cache; the
    // reread reflects the disk. The empty s2 row coerces to nothing.
    const path = join(dir, 'sessions.json')
    await writeFile(path, JSON.stringify({ s1: { title: 'Rewritten' }, s2: {} }))
    await expect(store.read()).resolves.toEqual({ s1: { title: 'Rewritten' } })
  })

  it('serializes concurrent upserts without trampling each other', async () => {
    const dir = await newDir()
    const store = new SessionMetaStore(dir)
    await Promise.all([
      store.upsert('s1', { title: 'One' }),
      store.upsert('s1', { title: 'Two' }),
      store.upsert('s2', { cwd: '/a' }),
      store.upsert('s3', { cwd: '/b', title: 'Three' }),
    ])
    await store.flush()
    const index = await store.read()
    expect(index.s1).toBeDefined()
    expect(['One', 'Two']).toContain(index.s1!.title)
    expect(index.s2).toEqual({ cwd: '/a' })
    expect(index.s3).toEqual({ cwd: '/b', title: 'Three' })
  })
})
