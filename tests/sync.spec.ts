import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { UsageLog } from '../src/usage-log.ts'
import { autoSyncIfNeeded, syncHistory, type SessionSnapshot, type SyncPersistence } from '../src/sync.ts'
import { readSyncProgress } from '../src/sync-state.ts'
import { messageEvent } from './helpers.ts'

interface FakeSession {
  id: string
  events: SessionEvent[]
}

/** Test fake persistence: holds sessions in memory, exposes the underlying
 *  session array so tests can append events without rebuilding the fake. */
class FakePersistence implements SyncPersistence {
  readonly sessions: FakeSession[]
  /** Per-session revision tokens — tests can mutate them to drive the
   *  short-circuit branch. Defaults are stable across a session's lifetime. */
  readonly revisions = new Map<string, string>()
  /** Count of `readFrom` calls per session id — tests can assert suffix-only
   *  semantics without instrumenting the event source itself. */
  readonly readFromCalls = new Map<string, number>()

  constructor(sessions: FakeSession[]) {
    this.sessions = sessions
    let n = 0
    for (const session of sessions) this.revisions.set(session.id, `rev-${++n}`)
  }

  private headerFor(session: FakeSession): SessionHeader {
    return { version: 0, id: session.id as SessionId, createdAt: 1_700_000_000_000 }
  }

  async listSnapshots(): Promise<SessionSnapshot[]> {
    return this.sessions.map(session => ({
      header: this.headerFor(session),
      revision: this.revisions.get(session.id) ?? 'rev-unknown',
    }))
  }

  async readFrom(id: SessionId, fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const id_ = String(id)
    this.readFromCalls.set(id_, (this.readFromCalls.get(id_) ?? 0) + 1)
    const session = this.sessions.find(candidate => candidate.id === id_)
    if (session === undefined) throw new Error(`missing session ${id_}`)
    const events = session.events.filter(event => event.seq >= fromSeq)
    return { meta: this.headerFor(session), events }
  }
}

function messageEventWith(id: string, seq: number, time = 1_700_000_000_000): SessionEvent<'assistant/message'> {
  return messageEvent({ messageId: id, seq, time })
}

describe('syncHistory', () => {
  it('appends one row per historical assistant/message event', async () => {
    const log = new FakeLog()
    const persistence = new FakePersistence([
      { id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] },
      { id: 's2', events: [messageEventWith('m3', 1)] },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 3, skipped: 0 })
  })

  it('ignores non-assistant/message events', async () => {
    const log = new FakeLog()
    const persistence = new FakePersistence([
      {
        id: 's1',
        events: [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as SessionEvent,
          messageEventWith('m1', 1),
          { type: 'assistant/chunk', seq: 2, time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } } as SessionEvent,
        ],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('dedupes rows already written this process', async () => {
    const log = new FakeLog()
    await log.recordRow('m1')
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1 })
  })

  it('dedupes rows found in the data files via scan', async () => {
    const log = new FakeLogWithFile()
    await log.seedFile('m1')
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1 })
  })

  it('throws AbortError when the signal is already aborted', async () => {
    const log = new FakeLog()
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    const controller = new AbortController()
    controller.abort()
    await expect(syncHistory({ persistence, log }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('stops mid-sync when the signal fires', async () => {
    let inspected = 0
    const log = new FakeLog()
    const persistence: SyncPersistence = {
      async listSnapshots() {
        return [
          { header: { version: 0, id: 's1' as SessionId, createdAt: 0 }, revision: 'r1' },
          { header: { version: 0, id: 's2' as SessionId, createdAt: 0 }, revision: 'r2' },
        ]
      },
      async readFrom() {
        inspected += 1
        const controller = new AbortController()
        controller.abort()
        controller.signal.throwIfAborted()
        return { meta: { version: 0, id: 's1' as SessionId, createdAt: 0 }, events: [] }
      },
    }
    await expect(syncHistory({ persistence, log })).rejects.toMatchObject({ name: 'AbortError' })
    expect(inspected).toBe(1)
  })
})

describe('autoSyncIfNeeded', () => {
  it('does a full sync on first run and writes the watermark and revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const log = new FakeLog()
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await autoSyncIfNeeded({ persistence, log }, dir)
    expect(result).toEqual({ added: 2, skipped: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1', 'm2'])
    const progress = await readSyncProgress(dir)
    // Both the seq watermark and the revision we observed must persist — the
    // revision powers the next-run short-circuit.
    expect(progress.sessions['s1']).toEqual({ lastSyncedSeq: 2, lastSeenRevision: 'rev-1' })
    expect(progress.syncedAt).toEqual(expect.any(Number))
  })

  it('walks only the suffix past the watermark on a re-install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const session: FakeSession = { id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }
    const persistence = new FakePersistence([session])
    const log = new FakeLog()
    await autoSyncIfNeeded({ persistence, log }, dir)
    // Reset the per-process dedupe set (mirrors a fresh UsageLog on the next boot).
    const freshLog = new FakeLog()
    // Append new events after the watermark was written. Real backends bump
    // the revision on every append; mirror that here so the short-circuit
    // (same revision ⇒ skip) does not swallow this test's intent.
    session.events.push(messageEventWith('m3', 3), messageEventWith('m4', 4))
    persistence.revisions.set('s1', 'rev-2')

    const result = await autoSyncIfNeeded({ persistence, log: freshLog }, dir)
    expect(result).toEqual({ added: 2, skipped: 0 })
    expect(freshLog.rows.map(row => row.requestId)).toEqual(['m3', 'm4'])
    expect(persistence.readFromCalls.get('s1')).toBe(2)

    const progress = await readSyncProgress(dir)
    expect(progress.sessions['s1']).toEqual({ lastSyncedSeq: 4, lastSeenRevision: 'rev-2' })
  })

  it('skips readFrom when the stored log has not changed since the last sync', async () => {
    // Mirrors the typical no-event restart: the previous sync already wrote
    // the watermark + revision, the persisted log is unchanged, and reading
    // `readFrom(lastSynced + 1)` would only walk the artifact to confirm an
    // empty suffix. The sync must avoid that cost.
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const session: FakeSession = { id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }
    const persistence = new FakePersistence([session])
    await autoSyncIfNeeded({ persistence, log: new FakeLog() }, dir)
    expect(persistence.readFromCalls.get('s1')).toBe(1)

    // Same revision, no new events — short-circuit.
    const freshLog = new FakeLog()
    const result = await autoSyncIfNeeded({ persistence, log: freshLog }, dir)
    expect(result).toEqual({ added: 0, skipped: 0 })
    expect(freshLog.rows).toHaveLength(0)
    expect(persistence.readFromCalls.get('s1')).toBe(1)
  })

  it('still re-syncs when the revision advances', async () => {
    // A new event appended after the last sync bumps the revision — even if
    // the seq watermark would also catch it, the revision advance alone
    // forces `readFrom` so the short-circuit never silently drops a tail.
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const session: FakeSession = { id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }
    const persistence = new FakePersistence([session])
    await autoSyncIfNeeded({ persistence, log: new FakeLog() }, dir)
    expect(persistence.readFromCalls.get('s1')).toBe(1)

    // Bump revision and append a new event past the watermark.
    persistence.revisions.set('s1', 'rev-2')
    session.events.push(messageEventWith('m3', 3))

    const freshLog = new FakeLog()
    const result = await autoSyncIfNeeded({ persistence, log: freshLog }, dir)
    expect(result).toEqual({ added: 1, skipped: 0 })
    expect(freshLog.rows.map(row => row.requestId)).toEqual(['m3'])
    expect(persistence.readFromCalls.get('s1')).toBe(2)
  })

  it('does not pass a fromSeq beyond the stored prefix on a re-install', async () => {
    // Mirrors the readFrom contract: fromSeq past the prefix returns an empty
    // list, never an error. The sync must surface that as "nothing new".
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const log = new FakeLog()
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    await autoSyncIfNeeded({ persistence, log }, dir)

    // After the watermark, pretend the stored log was rotated and the new
    // session has no events past the watermark.
    const freshLog = new FakeLog()
    const result = await autoSyncIfNeeded({ persistence, log: freshLog }, dir)
    expect(result).toEqual({ added: 0, skipped: 0 })
    expect(freshLog.rows).toHaveLength(0)
  })

  it('falls back to a full sync when the marker is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const log = new FakeLog()
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    const result = await autoSyncIfNeeded({ persistence, log }, dir)
    expect(result).toEqual({ added: 1, skipped: 0 })
    const progress = await readSyncProgress(dir)
    expect(progress.sessions['s1']).toEqual({ lastSyncedSeq: 1, lastSeenRevision: 'rev-1' })
  })

  it('writes an empty progress map and returns null when there are no sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const log = new FakeLog()
    const persistence = new FakePersistence([])
    const result = await autoSyncIfNeeded({ persistence, log }, dir)
    // No sessions and nothing added — treat the run as a no-op for the caller's
    // log line, but still persist the progress map so the file always exists.
    expect(result).toBeNull()
    const progress = await readSyncProgress(dir)
    expect(progress).toEqual({ version: 2, sessions: {} })
  })

  it('dedupes rows the live hook already wrote into the log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    // Simulate that m1 was written by the live hook into the current process
    // before the sync starts (the live hook has no watermark — it just appends).
    const log = new FakeLog()
    await log.recordRow('m1')
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await autoSyncIfNeeded({ persistence, log }, dir)
    expect(result).toEqual({ added: 1, skipped: 1 })
    const progress = await readSyncProgress(dir)
    expect(progress.sessions['s1']).toEqual({ lastSyncedSeq: 2, lastSeenRevision: 'rev-1' })
  })

  it('folds events from sessions added since the previous sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const persistence = new FakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    const log = new FakeLog()
    await autoSyncIfNeeded({ persistence, log }, dir)

    // A brand-new session the previous sync never saw. FakePersistence assigns
    // a fresh revision to each session it sees, so this is exactly the case
    // where the short-circuit cannot fire.
    persistence.sessions.push({ id: 's2', events: [messageEventWith('m2', 1)] })
    persistence.revisions.set('s2', 'rev-2')
    const freshLog = new FakeLog()
    const result = await autoSyncIfNeeded({ persistence, log: freshLog }, dir)
    expect(result).toEqual({ added: 1, skipped: 0 })
    const progress = await readSyncProgress(dir)
    expect(progress.sessions['s2']).toEqual({ lastSyncedSeq: 1, lastSeenRevision: 'rev-2' })
  })
})

/** In-memory UsageLog twin recording rows for assertions. */
class FakeLog implements Pick<UsageLog, 'scan' | 'record'> {
  readonly rows: Array<{ requestId: string }> = []
  readonly seen = new Set<string>()

  async scan(): Promise<void> {}

  record(row: { requestId: string }): Promise<boolean> {
    if (this.seen.has(row.requestId)) return Promise.resolve(false)
    this.seen.add(row.requestId)
    this.rows.push(row)
    return Promise.resolve(true)
  }

  recordRow(requestId: string): Promise<boolean> {
    return this.record({ requestId })
  }
}

/** FakeLog that simulates pre-existing data files the scan must absorb. */
class FakeLogWithFile extends FakeLog {
  private readonly fileSeen = new Set<string>()

  async seedFile(requestId: string): Promise<void> {
    this.fileSeen.add(requestId)
  }

  override async scan(): Promise<void> {
    for (const id of this.fileSeen) this.seen.add(id)
  }
}