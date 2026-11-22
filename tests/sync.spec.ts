import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { BACKUPS_DIR, isBackupSnapshotName } from '../src/backup.ts'
import { autoSyncIfNeeded, syncHistory, type SyncLog, type SyncPersistence } from '../src/sync.ts'
import { isInitialized } from '../src/sync-state.ts'
import { UsageLog } from '../src/usage-log.ts'
import { serializeRecord, type UsageRecord } from '../src/usage-record.ts'
import { compactionEvent, messageEvent, pruneEvent, retryEvent, turnEndEvent } from './helpers.ts'

function fakePersistence(sessions: Array<{ id: string; events: SessionEvent[]; header?: { cwd?: string; origin?: 'subagent'; parentSession?: string } }>): SyncPersistence {
  return {
    async list() {
      return sessions.map(session => ({ header: { id: session.id as SessionId } }))
    },
    async open(id) {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return {
        header: session.header,
        read() { return Promise.resolve({ events: session.events }) },
        close() { return Promise.resolve() },
      }
    },
  }
}

function messageEventWith(id: string, seq: number): SessionEvent<'assistant/message'> {
  return messageEvent({ messageId: id, seq })
}

describe('syncHistory', () => {
  it('appends one row per historical assistant/message event', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] },
      { id: 's2', events: [messageEventWith('m3', 1)] },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 3, skipped: 0, removed: 0, failedSessions: 0 })
  })

  it('ignores non-assistant/message events', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
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
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('extracts latencyMs and firstTokenLatencyMs across step boundaries', async () => {
    const log = new FakeLog()
    const msg = messageEvent({ messageId: 'm1', seq: 3, time: 4200, turn: 1, step: 1 })
    // The timed stream embedded in assistant/message carries the first
    // token delta at 1420.
    ;(msg.data as Record<string, unknown>).stream = [
      { type: 'text-chunks', time0: 1420, index: 0, dt: [580], texts: ['Hello', ' world'] },
    ]
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          { type: 'step/start', seq: 0, time: 1000, data: { turn: 1, step: 1 } } as SessionEvent,
          msg,
          { type: 'step/end', seq: 4, time: 4210, data: { turn: 1, step: 1 } } as SessionEvent,
        ],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result.added).toBe(1)
    expect(log.rows[0].latencyMs).toBe(3200)
    expect(log.rows[0].firstTokenLatencyMs).toBe(420)
  })

  it('extracts firstTokenLatencyMs from compact assistant stream when chunks are not in log', async () => {
    const log = new FakeLog()
    const msg = messageEvent({ messageId: 'm1', seq: 2, time: 4200, turn: 1, step: 1 })
    ;(msg.data as Record<string, unknown>).stream = [
      {
        type: 'text-chunks',
        time0: 1550,
        index: 0,
        dt: [100],
        texts: ['first token'],
      },
    ]
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          { type: 'step/start', seq: 0, time: 1000, data: { turn: 1, step: 1 } } as SessionEvent,
          msg,
          { type: 'step/end', seq: 3, time: 4210, data: { turn: 1, step: 1 } } as SessionEvent,
        ],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result.added).toBe(1)
    expect(log.rows[0].latencyMs).toBe(3200)
    expect(log.rows[0].firstTokenLatencyMs).toBe(550)
  })

  it('carries the provider-reported response model from the durable replay envelope', async () => {
    const log = new FakeLog()
    const routed = messageEvent({
      messageId: 'm1', seq: 1, model: 'zcode/GLM-5.3-Flash-Trial',
      replayState: {
        response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'p', model: 'zcode/GLM-5.3-Flash-Trial', responseModel: 'glm-5.3-flash', stopReason: 'stop' },
        blocks: [{ type: 'text' }],
      },
    })
    const unrouted = messageEventWith('m2', 2)
    const persistence = fakePersistence([{ id: 's1', events: [routed, unrouted] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 2, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows[0].model).toBe('zcode/GLM-5.3-Flash-Trial')
    expect(log.rows[0].responseModel).toBe('glm-5.3-flash')
    // A source without a replay envelope keeps the row field-free.
    expect('responseModel' in log.rows[1]!).toBe(false)
  })

  it('dedupes rows already written this process', async () => {
    const log = new FakeLog()
    await log.recordRow('m1')
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1, removed: 0, failedSessions: 0 })
  })

  it('dedupes rows found in the data files via scan', async () => {
    const log = new FakeLogWithFile()
    await log.seedFile('m1')
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1, removed: 0, failedSessions: 0 })
  })

  it('records compaction/summary events as compaction rows', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          compactionEvent({ seq: 4 }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 2, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1', 'compaction:s1:4'])
    expect(log.rows[1]).toMatchObject({ kind: 'compaction', model: 'deepseek-chat', provider: 'deepseek' })
  })

  it('records errored turn/end events as failure rows attributed to the tracked model', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          turnEndEvent({ seq: 5, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 2, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows[1]).toMatchObject({
      requestId: 'failure:s1:5',
      kind: 'failure',
      model: 'deepseek-chat',
    })
  })

  it('follows request/context route changes to attribute failure models', async () => {
    const log = new FakeLog()
    const routeChange = {
      type: 'request/context',
      seq: 3,
      time: 3,
      data: { provider: 'kimi', model: 'kimi-k2' },
    } as SessionEvent
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          routeChange,
          turnEndEvent({ seq: 4 }),
        ] as SessionEvent[],
      },
    ])
    await syncHistory({ persistence, log })
    // The failure row names the route's model, not the message's.
    expect(log.rows[1]).toMatchObject({ kind: 'failure', model: 'kimi-k2', provider: 'kimi' })
  })

  it('records a failure with an empty model when no route was ever observed', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [turnEndEvent({ seq: 1 })] as SessionEvent[] },
    ])
    await syncHistory({ persistence, log })
    expect(log.rows[0]).toMatchObject({ requestId: 'failure:s1:1', model: '' })
  })

  it('records llm/retry events as failure rows attributed to the tracked model', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          retryEvent({ seq: 4 }),
          retryEvent({ seq: 6, retry: 2 }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 3, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.slice(1)).toEqual([
      expect.objectContaining({
        requestId: 'failure:s1:4',
        kind: 'failure',
        model: 'deepseek-chat',
        failureCode: 'RATE_LIMIT',
        provider: 'deepseek',
      }),
      expect.objectContaining({
        requestId: 'failure:s1:6',
        kind: 'failure',
        failureCode: 'RATE_LIMIT',
      }),
    ])
  })

  it('records both retried attempts and a terminal turn/end error without colliding', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          retryEvent({ seq: 4 }),
          turnEndEvent({ seq: 7 }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 2, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['failure:s1:4', 'failure:s1:7'])
  })

  it('ignores llm/retry-started wait-complete markers', async () => {
    const log = new FakeLog()
    const started = {
      type: 'llm/retry-started',
      seq: 5,
      time: 5,
      data: { retryId: 'retry-1', turn: 1, step: 1, retry: 1 },
    } as SessionEvent
    const persistence = fakePersistence([
      { id: 's1', events: [retryEvent({ seq: 4 }), started] },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['failure:s1:4'])
  })

  it('dedupes retry failure rows across repeated syncs', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [retryEvent({ seq: 4 })] as SessionEvent[] },
    ])
    await syncHistory({ persistence, log })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 1, removed: 0, failedSessions: 0 })
  })

  it('skips turn/end events for non-error endings', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          turnEndEvent({ seq: 2, reason: { kind: 'completed' } }),
          turnEndEvent({ seq: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
          turnEndEvent({ seq: 4, reason: { kind: 'max-tokens' } }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows).toHaveLength(0)
  })

  it('dedupes failure rows across repeated syncs', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [turnEndEvent({ seq: 5 })] as SessionEvent[] },
    ])
    await syncHistory({ persistence, log })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 1, removed: 0, failedSessions: 0 })
  })

  it('skips compaction/summary events without usable usage', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          compactionEvent({ seq: 4, usage: undefined }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('dedupes compaction rows across repeated syncs', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          compactionEvent({ seq: 4 }),
        ] as SessionEvent[],
      },
    ])
    await syncHistory({ persistence, log })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 2, removed: 0, failedSessions: 0 })
  })

  it('skips compaction/summary events when recordCompaction is false', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          messageEventWith('m1', 1),
          compactionEvent({ seq: 4 }),
        ] as SessionEvent[],
      },
    ])
    const result = await syncHistory({ persistence, log, recordCompaction: false })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('throws AbortError when the signal is already aborted', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    const controller = new AbortController()
    controller.abort()
    await expect(syncHistory({ persistence, log }, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('stops mid-sync when the signal fires', async () => {
    let opened = 0
    const log = new FakeLog()
    const persistence: SyncPersistence = {
      async list() {
        return [{ header: { id: 's1' as SessionId } }, { header: { id: 's2' as SessionId } }]
      },
      async open() {
        opened += 1
        const controller = new AbortController()
        controller.abort()
        controller.signal.throwIfAborted()
        throw new Error('unreachable')
      },
    }
    await expect(syncHistory({ persistence, log })).rejects.toMatchObject({ name: 'AbortError' })
    expect(opened).toBe(1)
  })
})

describe('autoSyncIfNeeded', () => {
  it('syncs and writes the marker on first run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const log = new FakeLog()
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    const result = await autoSyncIfNeeded({ persistence, log }, dir)
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
    expect(await isInitialized(dir)).toBe(true)
  })

  it('skips when the marker is already present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-auto-'))
    const log = new FakeLog()
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    await autoSyncIfNeeded({ persistence, log }, dir)
    expect(await autoSyncIfNeeded({ persistence, log }, dir)).toBeNull()
    expect(log.rows).toHaveLength(1)
  })
})

describe('syncHistory progress', () => {
  it('emits a tick before the first session and one tick per session', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [messageEventWith('m1', 1)] },
      { id: 's2', events: [messageEventWith('m2', 1), messageEventWith('m3', 2)] },
    ])
    const ticks: Array<{ processed: number; total: number; added: number; skipped: number; removed: number; failedSessions: number }> = []
    const result = await syncHistory({ persistence, log },
      tick => { ticks.push({ ...tick }) },
    )
    expect(result).toEqual({ added: 3, skipped: 0, removed: 0, failedSessions: 0 })
    // One leading tick at processed: 0, then one per session.
    expect(ticks).toEqual([
      { processed: 0, total: 2, added: 0, skipped: 0, removed: 0, failedSessions: 0 },
      { processed: 1, total: 2, added: 1, skipped: 0, removed: 0, failedSessions: 0 },
      { processed: 2, total: 2, added: 3, skipped: 0, removed: 0, failedSessions: 0 },
    ])
  })

  it('reports total: 0 when the persistence lists no sessions', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([])
    const ticks: number[] = []
    const result = await syncHistory({ persistence, log },
      tick => { ticks.push(tick.total) },
    )
    expect(result).toEqual({ added: 0, skipped: 0, removed: 0, failedSessions: 0 })
    expect(ticks).toEqual([0])
  })
})

describe('syncHistory unreadable sessions', () => {
  /** Persistence twin whose open throws for the listed ids, mimicking a
   * stored log the current dsh build fails to load or validate. */
  function persistenceWithFailures(
    sessions: Array<{ id: string; events: SessionEvent[] }>,
    failingIds: string[],
  ): SyncPersistence {
    const inner = fakePersistence(sessions)
    return {
      ...inner,
      async open(id) {
        if (failingIds.includes(id)) {
          throw new Error(`stored session "${id}" failed validation`)
        }
        return inner.open(id)
      },
    }
  }

  it('skips a session whose open throws, records it, and continues the walk', async () => {
    const log = new FakeLog()
    const failures: Array<{ id: string; message: string }> = []
    const persistence = persistenceWithFailures([
      { id: 'broken', events: [messageEventWith('m1', 1)] },
      { id: 's2', events: [messageEventWith('m2', 1), messageEventWith('m3', 2)] },
      { id: 's3', events: [messageEventWith('m4', 1)] },
    ], ['broken'])
    const ticks: Array<{ processed: number; total: number; removed: number; failedSessions: number }> = []
    const result = await syncHistory({ persistence, log,
        onSessionFailure: (id, error) => { failures.push({ id, message: error instanceof Error ? error.message : String(error) }) } },
      tick => { ticks.push({ processed: tick.processed, total: tick.total, removed: tick.removed, failedSessions: tick.failedSessions }) },
    )
    // The readable sessions still land; the broken one is counted, reported,
    // and progresses the bar so it always reaches `total`.
    expect(result).toEqual({ added: 3, skipped: 0, removed: 0, failedSessions: 1 })
    expect(log.rows.map(row => row.requestId).sort()).toEqual(['m2', 'm3', 'm4'])
    expect(failures).toEqual([{ id: 'broken', message: 'stored session "broken" failed validation' }])
    expect(ticks.map(tick => tick.failedSessions)).toEqual([0, 1, 1, 1])
    expect(ticks.at(-1)).toEqual({ processed: 3, total: 3, removed: 0, failedSessions: 1 })
  })

  it('keeps the run alive when every session fails, then succeeds again', async () => {
    const log = new FakeLog()
    const persistence = persistenceWithFailures([
      { id: 'a', events: [] },
      { id: 'b', events: [] },
    ], ['a', 'b'])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 0, removed: 0, failedSessions: 2 })
  })

  it('re-throws a read failure raised after the signal aborts', async () => {
    const log = new FakeLog()
    const controller = new AbortController()
    const persistence: SyncPersistence = {
      async list() { return [{ header: { id: 's1' as SessionId } }] },
      async open() {
        // The caller cancels while the read is failing: the failure is the
        // caller's abort, not a session to skip.
        controller.abort()
        throw new Error('torn read')
      },
    }
    await expect(syncHistory({ persistence, log }, undefined, controller.signal)).rejects.toThrow('torn read')
  })
})

/**
 * In-memory UsageLog twin: records rows for assertions and reproduces the
 * reconcile contract — a row outside `keep` is dropped only when its owning
 * session was read in full, and only ids in the pre-walk `eligible` snapshot
 * are candidates.
 */
class FakeLog implements SyncLog {
  readonly rows: Array<{ requestId: string; sessionId?: string }> = []
  readonly seen = new Set<string>()
  /** Every reconcile call this twin received, for assertions. */
  readonly reconciles: Array<{
    keep: ReadonlySet<string>
    readableSessions: ReadonlySet<string>
    eligible: ReadonlySet<string>
  }> = []
  private readonly owners = new Map<string, string>()

  async scan(): Promise<void> {}

  ids(): ReadonlySet<string> {
    return new Set(this.seen)
  }

  record(row: { requestId: string; sessionId?: string }): Promise<boolean> {
    if (this.seen.has(row.requestId)) return Promise.resolve(false)
    this.seen.add(row.requestId)
    if (row.sessionId !== undefined) this.owners.set(row.requestId, row.sessionId)
    this.rows.push(row)
    return Promise.resolve(true)
  }

  recordRow(requestId: string): Promise<boolean> {
    return this.record({ requestId })
  }

  reconcile(
    keep: ReadonlySet<string>,
    readableSessions: ReadonlySet<string>,
    eligible: ReadonlySet<string>,
  ): Promise<number> {
    this.reconciles.push({ keep, readableSessions, eligible })
    let removed = 0
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const row = this.rows[index]
      /* v8 ignore next -- the loop index always addresses an existing row. */
      if (row === undefined) continue
      if (!eligible.has(row.requestId)) continue
      if (keep.has(row.requestId)) continue
      if (!readableSessions.has(this.owners.get(row.requestId) ?? row.sessionId ?? '')) continue
      this.rows.splice(index, 1)
      this.seen.delete(row.requestId)
      this.owners.delete(row.requestId)
      removed += 1
    }
    return Promise.resolve(removed)
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

describe('syncHistory metadata capture', () => {
  it('folds the latest-wins title and the header facts into the sink', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          titleEvent('Auto title', 1),
          titleEvent('User rename', 2),
          messageEventWith('m1', 3),
        ] as SessionEvent[],
        header: { cwd: '/work/app', origin: 'subagent', parentSession: 'p0' },
      },
      { id: 's2', events: [messageEventWith('m2', 1)] },
    ])
    const upserts: Array<{ id: string; patch: Record<string, unknown> }> = []
    const result = await syncHistory({
      persistence,
      log,
      meta: { async upsert(id, patch) { upserts.push({ id, patch: { ...patch } }) } },
    })
    expect(result.added).toBe(2)
    // One upsert per session: s1 carries the LAST title (latest-wins) plus
    // the immutable header facts; s2 (no title, no header) upserts nothing.
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toEqual({
      id: 's1',
      patch: { title: 'User rename', cwd: '/work/app', origin: 'subagent', parentSession: 'p0' },
    })
  })

  it('skips an empty or non-string title instead of fabricating one', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [titleEvent('', 1), titleEvent(42 as unknown as string, 2)] as SessionEvent[],
      },
    ])
    const upserts: Array<{ id: string; patch: Record<string, unknown> }> = []
    await syncHistory({
      persistence,
      log,
      meta: { async upsert(id, patch) { upserts.push({ id, patch: { ...patch } }) } },
    })
    expect(upserts).toHaveLength(0)
  })

  it('runs without a meta sink (usage-only sync unchanged)', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [messageEventWith('m1', 1)] },
    ])
    const result = await syncHistory({ persistence, log })
    expect(result.added).toBe(1)
  })
})

/** Minimal but shape-true `session/title` event (host-merged payload, read
 * duck-typed by the sync — hence the cast). */
function titleEvent(title: string, seq: number): SessionEvent<'session/title'> {
  return {
    type: 'session/title',
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  } as unknown as SessionEvent<'session/title'>
}

/**
 * Persistence twin with observable handle lifecycle: `list({ signal })`
 * reports ids under `header`, and `open(id, 'read')` hands back a handle
 * whose `read()` yields the log while `header` carries the identity facts.
 * The hooks expose open/close failures for the unreadable-session paths.
 */
function handlePersistence(
  sessions: Array<{
    id: string
    events: SessionEvent[]
    header?: { cwd?: string; origin?: 'subagent'; parentSession?: string }
  }>,
  hooks: { onClose?: (id: string) => void; closeFails?: string[]; openFails?: string[] } = {},
): SyncPersistence {
  return {
    async list(options) {
      // The handle generation takes an options object; a bare positional
      // signal would mean the probe chose the wrong call shape.
      expect(options).toBeTypeOf('object')
      return sessions.map(session => ({ header: { id: session.id as SessionId } }))
    },
    async open(id) {
      if (hooks.openFails?.includes(id) === true) throw new Error(`stored session "${id}" failed validation`)
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return {
        header: session.header,
        read() { return Promise.resolve({ events: session.events }) },
        close() {
          hooks.onClose?.(id)
          return hooks.closeFails?.includes(id) === true
            ? Promise.reject(new Error(`close failed for ${id}`))
            : Promise.resolve()
        },
      }
    },
  }
}

describe('syncHistory handle lifecycle', () => {
  it('walks list({ signal }) + open/read and closes every handle exactly once', async () => {
    const log = new FakeLog()
    const closed: string[] = []
    const persistence = handlePersistence([
      { id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] },
      { id: 's2', events: [messageEventWith('m3', 1)] },
    ], { onClose: id => { closed.push(id) } })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 3, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1', 'm2', 'm3'])
    // Exactly one close per session: a leaked read handle is a host-side leak.
    expect(closed).toEqual(['s1', 's2'])
  })

  it('projects the handle header into the meta sink', async () => {
    const log = new FakeLog()
    const persistence = handlePersistence([
      {
        id: 's1',
        events: [titleEvent('Auto title', 1), messageEventWith('m1', 2)],
        header: { cwd: '/work/app', origin: 'subagent', parentSession: 'p0' },
      },
      { id: 's2', events: [messageEventWith('m2', 1)] },
    ])
    const upserts: Array<{ id: string; patch: Record<string, unknown> }> = []
    const result = await syncHistory({
      persistence,
      log,
      meta: { async upsert(id, patch) { upserts.push({ id, patch: { ...patch } }) } },
    })
    expect(result.added).toBe(2)
    // The identity facts ride on `handle.header`, not on the read result:
    // dropping that projection would silently empty the session table.
    expect(upserts).toEqual([
      { id: 's1', patch: { title: 'Auto title', cwd: '/work/app', origin: 'subagent', parentSession: 'p0' } },
    ])
  })

  it('keeps a session readable when its close fails', async () => {
    const log = new FakeLog()
    const persistence = handlePersistence(
      [{ id: 's1', events: [messageEventWith('m1', 1)] }],
      { closeFails: ['s1'] },
    )
    // Teardown is best-effort: the rows are already collected, so a failing
    // close must not turn a good read into an unreadable session.
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 0 })
  })

  it('skips a session whose open throws and continues the walk', async () => {
    const log = new FakeLog()
    const failures: string[] = []
    const persistence = handlePersistence([
      { id: 'broken', events: [messageEventWith('m1', 1)] },
      { id: 's2', events: [messageEventWith('m2', 1)] },
    ], { openFails: ['broken'] })
    const result = await syncHistory({
      persistence,
      log,
      onSessionFailure: (id) => { failures.push(id) },
    })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, failedSessions: 1 })
    expect(failures).toEqual(['broken'])
    expect(log.rows.map(row => row.requestId)).toEqual(['m2'])
  })
})

/**
 * Twin whose pre-walk snapshot is taken before a live row lands: it injects
 * that row while answering `ids()`, which is exactly the window the real log
 * leaves open between the snapshot and the closing reconcile pass.
 */
class MidWalkLog extends FakeLog {
  override ids(): ReadonlySet<string> {
    const snapshot = super.ids()
    // A live request lands after the snapshot but before the walk ends.
    void this.record({ requestId: 'live-row', sessionId: 's1' })
    return snapshot
  }
}

describe('syncHistory reconcile', () => {
  it('removes rows no readable session reproduces, and protects unreadable ones', async () => {
    const log = new FakeLog()
    // Relic of an older coordinate: the walk now yields failure:s1:5 instead.
    await log.record({ requestId: 'failure:s1:999', sessionId: 's1' })
    // Owned by a session whose log cannot be read: it must survive the pass.
    await log.record({ requestId: 'failure:broken:42', sessionId: 'broken' })
    const persistence = handlePersistence([
      { id: 's1', events: [retryEvent({ seq: 5 })] as SessionEvent[] },
      { id: 'broken', events: [retryEvent({ seq: 7 })] as SessionEvent[] },
    ], { openFails: ['broken'] })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 1, failedSessions: 1 })
    expect(log.rows.map(row => row.requestId).sort()).toEqual(['failure:broken:42', 'failure:s1:5'])
    // The pass ran once, over exactly the ids the walk kept and the sessions
    // it could not read; its candidate set is the pre-walk snapshot.
    expect(log.reconciles).toHaveLength(1)
    expect([...(log.reconciles[0]?.keep ?? [])]).toEqual(['failure:s1:5'])
    expect([...(log.reconciles[0]?.readableSessions ?? [])]).toEqual(['s1'])
    expect([...(log.reconciles[0]?.eligible ?? [])].sort()).toEqual(['failure:broken:42', 'failure:s1:999'])
  })

  it('never drops a row that lands after the pre-walk snapshot', async () => {
    const log = new MidWalkLog()
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    const result = await syncHistory({ persistence, log })
    // The live row was not in the snapshot, so it is not a deletion
    // candidate even though no session log reproduces it.
    expect(result.removed).toBe(0)
    expect(log.rows.map(row => row.requestId).sort()).toEqual(['live-row', 'm1'])
  })

  it('removes nothing on a clean re-run', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1)] }])
    await syncHistory({ persistence, log })
    const second = await syncHistory({ persistence, log })
    expect(second).toEqual({ added: 0, skipped: 1, removed: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('skips DeepSeek chat imported history, counts it, and drops rows an older build recorded for it', async () => {
    const log = new FakeLog()
    // Rows an older build wrote for the imported reply and its excluded-reply turn error.
    await log.record({ requestId: 'imported-reply', sessionId: 's1' })
    await log.record({ requestId: 'failure:s1:2', sessionId: 's1' })
    const persistence = fakePersistence([{
      id: 's1',
      events: [
        messageEvent({ messageId: 'imported-reply', seq: 1, provider: 'deepseek-chat-export', model: 'deepseek-chat-export', usage: undefined }),
        turnEndEvent({ seq: 2, reason: { kind: 'error', error: { code: 'DEEPSEEK_EXPORT_NO_REPLY', message: 'no reply' } } }),
        // The user continues the imported conversation on a real route.
        { type: 'request/context', seq: 3, time: 3, data: { model: 'deepseek-v4', provider: 'deepseek' } } as SessionEvent,
        messageEvent({ messageId: 'real-reply', seq: 4, model: 'deepseek-v4' }),
        turnEndEvent({ seq: 5 }),
      ],
    }])
    const ticks: Array<number | undefined> = []
    const result = await syncHistory({ persistence, log }, tick => { ticks.push(tick.ignoredImported) })
    expect(result).toEqual({ added: 2, skipped: 0, removed: 2, failedSessions: 0, ignoredImported: 2 })
    expect(ticks).toEqual([undefined, 2])
    expect(log.rows.map(row => row.requestId).sort()).toEqual(['failure:s1:5', 'real-reply'])
    const failure = log.rows.find(row => row.requestId === 'failure:s1:5') as UsageRecord | undefined
    expect(failure?.model).toBe('deepseek-v4')
  })
})

function endSeedEvent(seq: number, inherited?: true): SessionEvent<'session/end-seed'> {
  return {
    type: 'session/end-seed',
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data: inherited ? { inherited: true } : {},
  } as SessionEvent<'session/end-seed'>
}

function requestHeaderEvent(seq: number, model: string, provider: string): SessionEvent<'request/header'> {
  return {
    type: 'request/header',
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data: {
      reason: 'resume',
      header: {
        config: { provider, model },
      },
    },
  } as unknown as SessionEvent<'request/header'>
}

describe('syncHistory fork handling', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  it('skips parent segment read via handle.read(inheritedEventCount) when own title and route exist', async () => {
    const log = new FakeLog()
    const readCalls: Array<{ id: string; offset: number | undefined; length: number | undefined }> = []
    const parentEvents: SessionEvent[] = [
      titleEvent('Parent title', 0),
      messageEvent({ messageId: 'p-msg-1', seq: 1, provider: 'deepseek', model: 'deepseek-chat' }),
      compactionEvent({ seq: 2 }),
      retryEvent({ seq: 3 }),
    ]
    const childEvents: SessionEvent[] = [
      ...parentEvents,
      endSeedEvent(4, true),
      titleEvent('Fork title', 5),
      requestHeaderEvent(6, 'deepseek-reasoner', 'deepseek-official'),
      turnEndEvent({ seq: 7 }),
      messageEvent({ messageId: 'c-msg-1', seq: 8, provider: 'deepseek-official', model: 'deepseek-reasoner' }),
    ]
    const persistence: SyncPersistence = {
      async list() {
        return [
          { header: { id: 'fork-child' as SessionId } },
          { header: { id: 'parent' as SessionId } },
        ]
      },
      async open(id) {
        const isChild = id === 'fork-child'
        const all = isChild ? childEvents : parentEvents
        return {
          inheritedEventCount: isChild ? 4 : 0,
          async read(offset = 0, length = all.length) {
            readCalls.push({ id, offset, length })
            return { events: all.slice(offset, offset + length) }
          },
          async close() {},
        }
      },
    }
    const upserts: Array<{ id: string; patch: Record<string, unknown> }> = []
    const result = await syncHistory({
      persistence,
      log,
      meta: { async upsert(id, patch) { upserts.push({ id, patch: { ...patch } }) } },
    })

    // SQLite-style slice: fork-child reads only from offset 4 and never falls back to reading 0..4.
    expect(readCalls).toEqual([
      { id: 'fork-child', offset: 4, length: childEvents.length },
      { id: 'parent', offset: 0, length: parentEvents.length },
    ])
    expect(result).toEqual({ added: 5, skipped: 0, removed: 0, failedSessions: 0 })

    const byId = new Map(log.rows.map(row => [row.requestId, row]))
    expect(byId.get('p-msg-1')?.sessionId).toBe('parent')
    expect(byId.get('compaction:parent:2')?.sessionId).toBe('parent')
    expect(byId.get('failure:parent:3')?.sessionId).toBe('parent')
    expect(byId.has('compaction:fork-child:2')).toBe(false)
    expect(byId.has('failure:fork-child:3')).toBe(false)
    expect(byId.get('failure:fork-child:7')).toMatchObject({
      sessionId: 'fork-child',
      model: 'deepseek-reasoner',
      provider: 'deepseek-official',
    })
    expect(byId.get('c-msg-1')?.sessionId).toBe('fork-child')
    expect(upserts).toEqual([
      { id: 'fork-child', patch: { title: 'Fork title' } },
      { id: 'parent', patch: { title: 'Parent title' } },
    ])
  })

  it('reads prefix on demand to fold inherited title and route without persisting prefix rows or windows', async () => {
    const log = new FakeLog()
    const readCalls: Array<{ id: string; offset: number | undefined; length: number | undefined }> = []
    const parentEvents: SessionEvent[] = [
      titleEvent('Inherited title', 0),
      { type: 'step/start', seq: 1, time: 1_000, data: { turn: 1, step: 1 } } as SessionEvent,
      messageEvent({ messageId: 'p-msg-1', seq: 2, provider: 'kimi', model: 'kimi-k2' }),
      pruneEvent({ seq: 3, tokens: 500 }),
      compactionEvent({ seq: 4 }),
    ]
    const childEvents: SessionEvent[] = [
      ...parentEvents,
      endSeedEvent(5, true),
      // Own failure arrives BEFORE any own request/context or request/header.
      turnEndEvent({ seq: 6 }),
      // Own message must not inherit parent's openStep or compactionAttribution window.
      messageEvent({ messageId: 'c-msg-1', seq: 7, time: 5_000, provider: 'kimi', model: 'kimi-k2' }),
    ]
    const persistence: SyncPersistence = {
      async list() {
        return [{ header: { id: 'fork-child' as SessionId } }]
      },
      async open() {
        return {
          inheritedEventCount: 5,
          async read(offset = 0, length = childEvents.length) {
            readCalls.push({ id: 'fork-child', offset, length })
            return { events: childEvents.slice(offset, offset + length) }
          },
          async close() {},
        }
      },
    }
    const upserts: Array<{ id: string; patch: Record<string, unknown> }> = []
    const result = await syncHistory({
      persistence,
      log,
      meta: { async upsert(id, patch) { upserts.push({ id, patch: { ...patch } }) } },
    })

    expect(readCalls).toEqual([
      { id: 'fork-child', offset: 5, length: childEvents.length },
      { id: 'fork-child', offset: 0, length: 5 },
    ])
    expect(result).toEqual({ added: 2, skipped: 0, removed: 0, failedSessions: 0 })
    expect(log.rows).toHaveLength(2)
    expect(log.rows[0]).toMatchObject({
      requestId: 'failure:fork-child:6',
      sessionId: 'fork-child',
      model: 'kimi-k2',
      provider: 'kimi',
    })
    expect(log.rows[1]).toMatchObject({
      requestId: 'c-msg-1',
      sessionId: 'fork-child',
    })
    expect((log.rows[1] as unknown as UsageRecord).latencyMs).toBeUndefined()
    expect((log.rows[1] as unknown as UsageRecord).compactionAttribution).toBeUndefined()
    expect(upserts).toEqual([{ id: 'fork-child', patch: { title: 'Inherited title' } }])
  })

  it('handles JSONL-style handles ignoring offset and falling back to last inherited session/end-seed', async () => {
    const log = new FakeLog()
    const rootEvents: SessionEvent[] = [
      titleEvent('Root A', 0),
      messageEvent({ messageId: 'a-msg', seq: 1 }),
      compactionEvent({ seq: 2 }),
    ]
    const midEvents: SessionEvent[] = [
      ...rootEvents,
      endSeedEvent(3, true),
      retryEvent({ seq: 4 }),
      // Ordinary resume marker (no inherited: true) must NOT truncate own history.
      endSeedEvent(5),
      messageEvent({ messageId: 'b-msg', seq: 6 }),
    ]
    const leafEvents: SessionEvent[] = [
      ...midEvents,
      endSeedEvent(7, true),
      messageEvent({ messageId: 'c-msg', seq: 8 }),
    ]
    const persistence: SyncPersistence = {
      async list() {
        return [
          { header: { id: 'leaf-c' as SessionId } },
          { header: { id: 'mid-b' as SessionId } },
          { header: { id: 'root-a' as SessionId } },
        ]
      },
      async open(id) {
        if (id === 'leaf-c') {
          return {
            // Older host: no inheritedEventCount exposed; fallback must locate LAST inherited seed marker (seq 7).
            read: () => Promise.resolve({ events: leafEvents }),
            close: () => Promise.resolve(),
          }
        }
        if (id === 'mid-b') {
          return {
            // JSONL-style handle with inheritedEventCount that ignores offset and returns from seq 0.
            inheritedEventCount: 3,
            read: () => Promise.resolve({ events: midEvents }),
            close: () => Promise.resolve(),
          }
        }
        return {
          read: () => Promise.resolve({ events: rootEvents }),
          close: () => Promise.resolve(),
        }
      },
    }

    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 5, skipped: 0, removed: 0, failedSessions: 0 })
    const owners = new Map(log.rows.map(row => [row.requestId, row.sessionId]))
    expect(owners.get('a-msg')).toBe('root-a')
    expect(owners.get('compaction:root-a:2')).toBe('root-a')
    expect(owners.get('failure:mid-b:4')).toBe('mid-b')
    expect(owners.get('b-msg')).toBe('mid-b')
    expect(owners.get('c-msg')).toBe('leaf-c')
    expect(owners.has('compaction:mid-b:2')).toBe(false)
    expect(owners.has('compaction:leaf-c:2')).toBe(false)
    expect(owners.has('failure:leaf-c:4')).toBe(false)
  })

  it('repairs damaged pre-fix ledger on full sync: drops fork duplicates and reassigns misattributed parent messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-fork-repair-'))
    tempDirs.push(dir)
    const dayTime = new Date(2026, 0, 15, 12).getTime()

    const preExisting: UsageRecord[] = [
      // Previously misattributed to fork-child because sync walked child before parent.
      {
        requestId: 'p-msg-1',
        time: dayTime,
        sessionId: 'fork-child',
        model: 'deepseek-chat',
        usage: { inputTokens: 100, outputTokens: 20 },
        attemptTiming: { startedAt: dayTime - 400, settledAt: dayTime, firstTokenAt: dayTime - 300 },
      },
      // Duplicate compaction & failure billed under fork-child from inherited prefix.
      {
        requestId: 'compaction:fork-child:2',
        time: dayTime + 10,
        sessionId: 'fork-child',
        model: 'deepseek-chat',
        kind: 'compaction',
        usage: { inputTokens: 50_000, outputTokens: 200 },
      },
      {
        requestId: 'failure:fork-child:3',
        time: dayTime + 20,
        sessionId: 'fork-child',
        model: 'deepseek-chat',
        kind: 'failure',
        failureCode: 'RATE_LIMIT',
      },
      // Valid parent compaction/failure already present.
      {
        requestId: 'compaction:parent:2',
        time: dayTime + 10,
        sessionId: 'parent',
        model: 'deepseek-chat',
        kind: 'compaction',
        usage: { inputTokens: 50_000, outputTokens: 200 },
      },
      {
        requestId: 'failure:parent:3',
        time: dayTime + 20,
        sessionId: 'parent',
        model: 'deepseek-chat',
        kind: 'failure',
        failureCode: 'RATE_LIMIT',
      },
      // Child's own message.
      {
        requestId: 'c-msg-1',
        time: dayTime + 30,
        sessionId: 'fork-child',
        model: 'deepseek-chat',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]
    await writeFile(
      join(dir, 'usage-2026-01-15.jsonl'),
      preExisting.map(serializeRecord).join('\n') + '\n',
      'utf8',
    )

    const parentEvents: SessionEvent[] = [
      messageEvent({ messageId: 'p-msg-1', seq: 1, time: dayTime }),
      compactionEvent({ seq: 2, time: dayTime + 10 }),
      retryEvent({ seq: 3, time: dayTime + 20 }),
    ]
    const childEvents: SessionEvent[] = [
      ...parentEvents,
      endSeedEvent(4, true),
      messageEvent({ messageId: 'c-msg-1', seq: 5, time: dayTime + 30 }),
    ]
    const persistence: SyncPersistence = {
      async list() {
        return [
          { header: { id: 'fork-child' as SessionId } },
          { header: { id: 'parent' as SessionId } },
        ]
      },
      async open(id) {
        const isChild = id === 'fork-child'
        const all = isChild ? childEvents : parentEvents
        return {
          inheritedEventCount: isChild ? 3 : 0,
          read: (offset = 0, length = all.length) => Promise.resolve({ events: all.slice(offset, offset + length) }),
          close: () => Promise.resolve(),
        }
      },
    }

    const log = new UsageLog(dir)
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 4, removed: 2, failedSessions: 0, reassigned: 1 })

    const dayFile = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as UsageRecord)
    expect(dayFile.map(row => [row.requestId, row.sessionId])).toEqual([
      ['p-msg-1', 'parent'],
      ['compaction:parent:2', 'parent'],
      ['failure:parent:3', 'parent'],
      ['c-msg-1', 'fork-child'],
    ])
    expect(dayFile[0]!.attemptTiming).toEqual({
      startedAt: dayTime - 400,
      settledAt: dayTime,
      firstTokenAt: dayTime - 300,
    })

    // A backup snapshot was created before reconciling the day file.
    const snapshots = (await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith('-reconcile')).toBe(true)

    // Subsequent sync is completely clean.
    const repeat = await syncHistory({ persistence, log })
    expect(repeat).toEqual({ added: 0, skipped: 4, removed: 0, failedSessions: 0 })
  })

  it('extracts billed usage from assistant/attempt for CONTENT_REFUSED turn/end and llm/retry without leaking across forks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-refusal-sync-'))
    tempDirs.push(dir)
    const dayTime = new Date(2026, 0, 15, 12).getTime()
    const attempt = (seq: number, turn: number, step: number, inputTokens: number, outputTokens: number): SessionEvent => ({
      type: 'assistant/attempt',
      seq: SessionSeq(seq),
      time: dayTime + seq,
      data: {
        turn,
        step,
        stream: [{ type: 'chunk', time: dayTime + seq, chunk: { type: 'usage', usage: { inputTokens, outputTokens } } }],
      },
    })

    const parentEvents: SessionEvent[] = [
      { type: 'request/context', seq: SessionSeq(0), time: dayTime, data: { provider: 'deepseek-official', model: 'deepseek-chat' } } as SessionEvent,
      { type: 'step/start', seq: SessionSeq(1), time: dayTime + 1, data: { turn: 1, step: 1 } },
      // Inherited attempt + error in parent: billed once to parent.
      attempt(2, 1, 1, 300, 30),
      { type: 'step/end', seq: SessionSeq(3), time: dayTime + 3, data: { turn: 1, step: 1 } },
      turnEndEvent({ seq: 4, time: dayTime + 4, turn: 1, reason: { kind: 'error', error: { code: 'CONTENT_REFUSED', message: 'blocked' } } }),
    ]
    const childEvents: SessionEvent[] = [
      ...parentEvents,
      endSeedEvent(5, true),
      // Own turn with retry then terminal refusal.
      { type: 'step/start', seq: SessionSeq(6), time: dayTime + 6, data: { turn: 2, step: 1 } },
      attempt(7, 2, 1, 400, 10),
      retryEvent({ seq: 8, time: dayTime + 8, turn: 2, step: 1, failure: { code: 'CONTENT_REFUSED', message: 'retry blocked' } }),
      attempt(9, 2, 1, 500, 25),
      { type: 'step/end', seq: SessionSeq(10), time: dayTime + 10, data: { turn: 2, step: 1 } },
      turnEndEvent({ seq: 11, time: dayTime + 11, turn: 2, reason: { kind: 'error', error: { code: 'CONTENT_REFUSED', message: 'terminal blocked' } } }),
      // Next turn succeeds: must not reuse prior attempt usage.
      { type: 'step/start', seq: SessionSeq(12), time: dayTime + 12, data: { turn: 3, step: 1 } },
      attempt(13, 3, 1, 100, 5),
      messageEvent({ messageId: 'ok-3', seq: 14, time: dayTime + 14, turn: 3, step: 1, inputTokens: 100, outputTokens: 20 }),
      { type: 'step/end', seq: SessionSeq(15), time: dayTime + 15, data: { turn: 3, step: 1 } },
      // Terminal error with no attempt in turn 4: no stale usage attaches.
      turnEndEvent({ seq: 16, time: dayTime + 16, turn: 4, reason: { kind: 'error', error: { code: 'SERVER', message: 'boom' } } }),
    ]

    const persistence: SyncPersistence = {
      async list() {
        return [{ header: { id: 'parent' as SessionId } }, { header: { id: 'child' as SessionId } }]
      },
      async open(id) {
        const all = id === 'child' ? childEvents : parentEvents
        return {
          inheritedEventCount: id === 'child' ? parentEvents.length : 0,
          read: (offset = 0, length = all.length) => Promise.resolve({ events: all.slice(offset, offset + length) }),
          close: () => Promise.resolve(),
        }
      },
    }
    const log = new UsageLog(dir)
    await syncHistory({ persistence, log })
    const rows = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as UsageRecord)

    expect(rows.find(r => r.requestId === 'failure:parent:4')).toMatchObject({
      kind: 'failure', failureCode: 'CONTENT_REFUSED', usage: { inputTokens: 300, outputTokens: 30 },
    })
    expect(rows.find(r => r.requestId === 'failure:child:8')).toMatchObject({
      kind: 'failure', failureCode: 'CONTENT_REFUSED', usage: { inputTokens: 400, outputTokens: 10 },
    })
    expect(rows.find(r => r.requestId === 'failure:child:11')).toMatchObject({
      kind: 'failure', failureCode: 'CONTENT_REFUSED', usage: { inputTokens: 500, outputTokens: 25 },
    })
    expect(rows.find(r => r.requestId === 'failure:child:16')?.usage).toBeUndefined()
  })
})
