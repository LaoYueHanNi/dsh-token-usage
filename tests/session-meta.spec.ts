import { mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionMetaStore } from '../src/session-meta.ts'

// Writes land as temp file + rename, so the rename count IS the write count:
// the one observable that tells a batched upsert (one rewrite) from a
// per-row one. Behaviour is unchanged — this only counts.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const renameMock = vi.mocked(rename)

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

describe('SessionMetaStore subagent identity', () => {
  it('reads the subagent identity and team-mode fields and drops unusable ones', async () => {
    const dir = await newDir()
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({
      root: { title: 'Root', teamMode: true },
      'off-root': { teamMode: false },
      researcher: {
        parentSession: 'root', origin: 'subagent', subagentName: 'researcher', subagentLabel: '调研定价', subagentMode: 'continuable',
      },
      'ext-1': { parentSession: 'root', subagentName: 'codex-helper', subagentMode: 'external' },
      bad: { subagentName: '', subagentLabel: 7, subagentMode: 'unknown', teamMode: 'yes' },
    }))
    const store = new SessionMetaStore(dir)
    await expect(store.read()).resolves.toEqual({
      root: { title: 'Root', teamMode: true },
      'off-root': { teamMode: false },
      researcher: {
        parentSession: 'root', origin: 'subagent', subagentName: 'researcher', subagentLabel: '调研定价', subagentMode: 'continuable',
      },
      'ext-1': { parentSession: 'root', subagentName: 'codex-helper', subagentMode: 'external' },
    })
  })

  it('lands an external child under its catalog parent with no origin (never in the lineage)', async () => {
    const store = new SessionMetaStore(await newDir())
    await store.upsert('ext-1', { parentSession: 'root', subagentName: 'codex-helper', subagentMode: 'external' })
    await expect(store.read()).resolves.toEqual({
      'ext-1': { parentSession: 'root', subagentName: 'codex-helper', subagentMode: 'external' },
    })
  })

  it('lands a whole batch with ONE rewrite and leaves unchanged rows alone', async () => {
    const dir = await newDir()
    const store = new SessionMetaStore(dir)
    await store.upsert('root', { title: 'Root', teamMode: true })
    const first = {
      id: 'a', patch: { parentSession: 'root', subagentName: 'agent-1', subagentMode: 'continuable' as const, subagentLabel: 'one' },
    }
    const second = {
      id: 'b', patch: { parentSession: 'root', subagentName: 'reviewer', subagentMode: 'continuable' as const, subagentLabel: 'two' },
    }
    const external = { id: 'ext', patch: { parentSession: 'root', subagentName: 'codex', subagentMode: 'external' as const } }
    renameMock.mockClear()
    await store.upsertMany([first, second, external])
    // Three children of one parent: a single temp file + rename, not three.
    expect(renameMock).toHaveBeenCalledTimes(1)
    const index = await store.read()
    expect(index.a).toEqual({ parentSession: 'root', subagentName: 'agent-1', subagentMode: 'continuable', subagentLabel: 'one' })
    expect(index.b).toEqual({ parentSession: 'root', subagentName: 'reviewer', subagentMode: 'continuable', subagentLabel: 'two' })
    expect(index.ext).toEqual({ parentSession: 'root', subagentName: 'codex', subagentMode: 'external' })
    // The batch touched neither the root's title nor its team mode.
    expect(index.root).toEqual({ title: 'Root', teamMode: true })
    // Re-landing the identical batch rewrites nothing.
    renameMock.mockClear()
    await store.upsertMany([first, second, external])
    expect(renameMock).not.toHaveBeenCalled()
    await expect(readdir(dir)).resolves.not.toContain('sessions.json.tmp')
  })

  it('applies a repeated id inside one batch in order', async () => {
    const store = new SessionMetaStore(await newDir())
    await store.upsertMany([
      { id: 'a', patch: { subagentLabel: 'from descriptor' }, fillOnly: true },
      { id: 'a', patch: { subagentLabel: 'from catalog' } },
      { id: 'a', patch: { subagentLabel: 'from a later descriptor' }, fillOnly: true },
    ])
    // The weak entry first fills the gap, the catalog then overrides, and
    // the trailing weak entry no longer gets past the catalog's value.
    await expect(store.read()).resolves.toEqual({ a: { subagentLabel: 'from catalog' } })
  })

  it('fill-only keeps what the index holds and fills only the gaps', async () => {
    const store = new SessionMetaStore(await newDir())
    // Walk order 1: the parent's catalog landed first.
    await store.upsert('a', { parentSession: 'root', subagentName: 'researcher', subagentLabel: 'from catalog', subagentMode: 'continuable' })
    await store.upsert('a', { subagentLabel: 'from descriptor', subagentMode: 'one-shot' }, { fillOnly: true })
    await expect(store.read()).resolves.toEqual({
      a: { parentSession: 'root', subagentName: 'researcher', subagentLabel: 'from catalog', subagentMode: 'continuable' },
    })
    // Walk order 2: the child's descriptor first, the catalog after. Either
    // way the catalog's statement is the one that survives…
    await store.upsert('b', { subagentLabel: 'from descriptor', subagentMode: 'one-shot' }, { fillOnly: true })
    await store.upsert('b', { parentSession: 'root', subagentLabel: 'from catalog', subagentMode: 'continuable' })
    expect((await store.read()).b).toEqual({ parentSession: 'root', subagentLabel: 'from catalog', subagentMode: 'continuable' })
    // …and a descriptor arriving later cannot unseat it.
    await store.upsert('b', { subagentLabel: 'from descriptor' }, { fillOnly: true })
    expect((await store.read()).b?.subagentLabel).toBe('from catalog')
  })

  it('a fill-only entry with no catalogue counterpart still lands', async () => {
    // A child whose parent's log is unreadable: the descriptor is all the
    // index will ever hold for it, and that is still worth stating.
    const store = new SessionMetaStore(await newDir())
    await store.upsert('orphan', { subagentLabel: 'from descriptor', subagentMode: 'one-shot' }, { fillOnly: true })
    await expect(store.read()).resolves.toEqual({ orphan: { subagentLabel: 'from descriptor', subagentMode: 'one-shot' } })
  })

  it('treats teamMode false as a recorded value, not as "unset"', async () => {
    const store = new SessionMetaStore(await newDir())
    await store.upsert('root', { teamMode: true })
    await store.upsert('root', { teamMode: false })
    await expect(store.read()).resolves.toEqual({ root: { teamMode: false } })
    // A later patch that does not mention the field leaves it alone.
    await store.upsert('root', { title: 'Renamed' })
    await expect(store.read()).resolves.toEqual({ root: { teamMode: false, title: 'Renamed' } })
  })

  it('does not create a row for a batch entry that states nothing', async () => {
    const store = new SessionMetaStore(await newDir())
    renameMock.mockClear()
    await store.upsertMany([{ id: 'a', patch: {} }, { id: '', patch: { title: 'no id' } }])
    await expect(store.read()).resolves.toEqual({})
    expect(renameMock).not.toHaveBeenCalled()
  })
})
