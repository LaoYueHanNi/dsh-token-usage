import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { LiveProgressBuffer, type LiveProgressDeps } from '../src/live-progress.ts'
import { writeSyncProgress, type SessionProgress, type SyncProgress } from '../src/sync-state.ts'
import type { SessionSnapshot, SyncPersistence } from '../src/sync.ts'

interface FakeSession {
  id: string
  revision: string
}

class FakePersistence implements Pick<SyncPersistence, 'listSnapshots'> {
  readonly sessions: FakeSession[]
  /** Every `listSnapshots` call: tests can assert cadence / serialization. */
  readonly listCalls = { count: 0 }

  constructor(sessions: FakeSession[]) {
    this.sessions = sessions
  }

  async listSnapshots(): Promise<SessionSnapshot[]> {
    this.listCalls.count += 1
    return this.sessions.map(session => ({
      header: { version: 0, id: session.id as SessionId, createdAt: 0 },
      revision: session.revision,
    }))
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'token-usage-live-'))
}

async function seedProgress(dir: string, sessions: Record<string, SessionProgress>): Promise<void> {
  const payload: SyncProgress = { version: 2, sessions }
  await writeSyncProgress(dir, payload)
}

describe('LiveProgressBuffer', () => {
  let dir: string
  let persistence: FakePersistence

  beforeEach(async () => {
    dir = await tempDir()
    persistence = new FakePersistence([
      { id: 'a', revision: 'rev-a-1' },
      { id: 'b', revision: 'rev-b-1' },
    ])
  })

  function makeBuffer(overrides: Partial<LiveProgressDeps> = {}): LiveProgressBuffer {
    return new LiveProgressBuffer({
      dir,
      persistence,
      ...overrides,
    })
  }

  it('loadBaseline pulls the on-disk progress into the in-memory map', async () => {
    await seedProgress(dir, {
      a: { lastSyncedSeq: 5, lastSeenRevision: 'rev-a-0' },
      b: { lastSyncedSeq: 9, lastSeenRevision: 'rev-b-0' },
    })
    const buf = makeBuffer()
    await buf.loadBaseline()
    // The in-memory map should mirror the disk exactly before any flush.
    expect(buf.getProgress().sessions).toEqual({
      a: { lastSyncedSeq: 5, lastSeenRevision: 'rev-a-0' },
      b: { lastSyncedSeq: 9, lastSeenRevision: 'rev-b-0' },
    })
  })

  it('markSynced is pure memory: no I/O, no listSnapshots', async () => {
    const buf = makeBuffer()
    await buf.loadBaseline()
    buf.markSynced('a' as SessionId, 10)
    buf.markSynced('b' as SessionId, 12)
    expect(persistence.listCalls.count).toBe(0)
    // state.json is untouched until a flush fires.
    await expect(readFile(join(dir, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('flushDirty writes the cache entries with the current revisions', async () => {
    const buf = makeBuffer()
    await buf.loadBaseline()
    buf.markSynced('a' as SessionId, 10)
    buf.markSynced('b' as SessionId, 12)
    expect(persistence.listCalls.count).toBe(0)

    await buf.flushDirty()

    expect(persistence.listCalls.count).toBe(1)
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    expect(onDisk.sessions.a).toEqual({ lastSyncedSeq: 10, lastSeenRevision: 'rev-a-1' })
    expect(onDisk.sessions.b).toEqual({ lastSyncedSeq: 12, lastSeenRevision: 'rev-b-1' })
  })

  it('flushDirty still refreshes baseline revisions when the cache is empty', async () => {
    // The cache may be empty (no live-hook events this run) but baseline
    // sessions still need their `lastSeenRevision` advanced to whatever
    // `listSnapshots` currently reports — otherwise the next startup walks
    // the entire session file for a no-op suffix read.
    persistence.sessions.push({ id: 'baseline', revision: 'rev-base-new' })
    await seedProgress(dir, {
      baseline: { lastSyncedSeq: 100, lastSeenRevision: 'rev-base-old' },
    })
    const buf = makeBuffer()
    await buf.loadBaseline()

    await buf.flushDirty()

    expect(persistence.listCalls.count).toBe(1)
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    expect(onDisk.sessions.baseline).toEqual({ lastSyncedSeq: 100, lastSeenRevision: 'rev-base-new' })
  })

  it('flushExpired flushes entries older than ttlMs and leaves fresh ones', async () => {
    const buf = makeBuffer({ ttlMs: 50 })
    await buf.loadBaseline()

    // 'a' is freshly touched (within TTL), 'b' is aged past it.
    buf.markSynced('a' as SessionId, 1)
    buf.markSynced('b' as SessionId, 2)
    await new Promise(resolve => setTimeout(resolve, 80))
    buf.markSynced('a' as SessionId, 3) // refresh 'a' so only 'b' is due

    await buf.flushExpired()

    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    expect(onDisk.sessions.b).toEqual({ lastSyncedSeq: 2, lastSeenRevision: 'rev-b-1' })
    // 'a' must still be in the cache (not yet due).
    expect(onDisk.sessions.a).toBeUndefined()
  })

  it('flushExpired with no due entries does not call listSnapshots', async () => {
    const buf = makeBuffer({ ttlMs: 60_000 })
    await buf.loadBaseline()
    buf.markSynced('a' as SessionId, 1)
    await buf.flushExpired()
    expect(persistence.listCalls.count).toBe(0)
  })

  it('skips cache entries whose session vanished from listSnapshots', async () => {
    // A session that existed at the live-hook moment may be gone by flush
    // time (it was abandoned). Its watermark must NOT be written — there is
    // no revision to anchor it, and writing an orphan entry would resurrect
    // a session the persistence layer already discarded.
    const buf = makeBuffer()
    await buf.loadBaseline()
    buf.markSynced('a' as SessionId, 10)
    buf.markSynced('gone' as SessionId, 7) // 'gone' is not in FakePersistence
    await buf.flushDirty()

    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    expect(onDisk.sessions.a).toEqual({ lastSyncedSeq: 10, lastSeenRevision: 'rev-a-1' })
    expect(onDisk.sessions.gone).toBeUndefined()
  })

  it('serializes concurrent flush calls — only one listSnapshots per round', async () => {
    // Three concurrent flushes (lazy + timer + dispose) must coalesce into
    // one `listSnapshots` call so the persistence layer never sees a
    // thundering herd of metadata reads.
    const buf = makeBuffer()
    await buf.loadBaseline()
    buf.markSynced('a' as SessionId, 1)
    await Promise.all([buf.flushDirty(), buf.flushDirty(), buf.flushDirty()])
    expect(persistence.listCalls.count).toBe(1)
  })

  it('dispose flushes remaining cache entries and stops the timer', async () => {
    const buf = makeBuffer({ intervalMs: 30 })
    await buf.loadBaseline()
    buf.start()
    buf.markSynced('a' as SessionId, 10)

    await buf.dispose()
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    expect(onDisk.sessions.a).toEqual({ lastSyncedSeq: 10, lastSeenRevision: 'rev-a-1' })
    // The timer must not fire again — wait past one interval and confirm
    // no second flush ran.
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(persistence.listCalls.count).toBe(1)
  })

  it('waits for loadBaseline before flushing if a flush races the load', async () => {
    // The live hook can fire before `loadBaseline()` resolves; without the
    // baseline gate the flush would write the cache over an empty
    // `progress` map and clobber the on-disk state. Seed the disk first
    // so a successful flush has something to write back.
    await seedProgress(dir, {
      baseline: { lastSyncedSeq: 100, lastSeenRevision: 'rev-base-old' },
    })
    persistence.sessions.push({ id: 'baseline', revision: 'rev-base-new' })

    const buf = makeBuffer()
    // Fire loadBaseline and flushDirty in the same tick — flush must
    // internally await the baseline load so it sees the on-disk entry.
    const loadPromise = buf.loadBaseline()
    const flushPromise = buf.flushDirty()
    await Promise.all([loadPromise, flushPromise])

    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    // Baseline's seq is preserved (live hook never touched it), and its
    // revision was refreshed to the latest from listSnapshots.
    expect(onDisk.sessions.baseline).toEqual({ lastSyncedSeq: 100, lastSeenRevision: 'rev-base-new' })
  })

  it('start is idempotent (a second call does not register a second timer)', async () => {
    // Use a long interval so the timer does not fire during the test —
    // we want to assert the *registration* is idempotent, not the firing.
    const buf = makeBuffer({ intervalMs: 60_000 })
    await buf.loadBaseline()
    buf.start()
    buf.start() // second call must not stack timers
    await buf.dispose()
    // Only dispose fired the flush path; the 60s timer did not.
    expect(persistence.listCalls.count).toBe(1)
  })

  it('preserves baseline entries that the live hook never touched', async () => {
    // Sessions already in state.json (from the startup sync's prior write)
    // must remain on disk even after the live hook drains a cache that
    // only touches a subset of them.
    await seedProgress(dir, {
      baseline: { lastSyncedSeq: 100, lastSeenRevision: 'rev-base' },
    })
    persistence.sessions.push({ id: 'baseline', revision: 'rev-base-new' })
    const buf = makeBuffer()
    await buf.loadBaseline()
    buf.markSynced('a' as SessionId, 10)
    await buf.flushDirty()

    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as SyncProgress
    // The live-hooked entry reflects the new revision.
    expect(onDisk.sessions.a).toEqual({ lastSyncedSeq: 10, lastSeenRevision: 'rev-a-1' })
    // The baseline entry picks up the latest revision via listSnapshots too.
    expect(onDisk.sessions.baseline).toEqual({ lastSyncedSeq: 100, lastSeenRevision: 'rev-base-new' })
  })
})