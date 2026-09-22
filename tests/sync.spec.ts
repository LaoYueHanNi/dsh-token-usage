import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { autoSyncIfNeeded, syncHistory, type SyncLog, type SyncPersistence } from '../src/sync.ts'
import { isInitialized } from '../src/sync-state.ts'
import { compactionEvent, messageEvent, retryEvent, turnEndEvent } from './helpers.ts'

function fakePersistence(sessions: Array<{ id: string; events: SessionEvent[]; meta?: { cwd?: string; origin?: 'subagent'; parentSession?: string } }>): SyncPersistence {
  return {
    async list() {
      return sessions.map(session => ({ id: session.id as SessionId }))
    },
    async inspect(id) {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return { events: session.events, ...(session.meta !== undefined ? { meta: session.meta } : {}) }
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
    // dsh 0.1.7 embeds the timed stream inside assistant/message (the
    // standalone chunk event is gone); the first token delta sits at 1420.
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
    expect(log.rows[1]).toMatchObject({ kind: 'compaction', model: 'deepseek-chat' })
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
    expect(log.rows[1]).toMatchObject({ kind: 'failure', model: 'kimi-k2' })
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
    let inspected = 0
    const log = new FakeLog()
    const persistence: SyncPersistence = {
      async list() {
        return [{ id: 's1' as SessionId }, { id: 's2' as SessionId }]
      },
      async inspect() {
        inspected += 1
        const controller = new AbortController()
        controller.abort()
        controller.signal.throwIfAborted()
        return { events: [] }
      },
    }
    await expect(syncHistory({ persistence, log })).rejects.toMatchObject({ name: 'AbortError' })
    expect(inspected).toBe(1)
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
  /** Persistence twin whose inspect throws for the listed ids, mimicking a
   * stored log the current dsh build fails to load or validate. */
  function persistenceWithFailures(
    sessions: Array<{ id: string; events: SessionEvent[] }>,
    failingIds: string[],
  ): SyncPersistence {
    const inner = fakePersistence(sessions)
    return {
      ...inner,
      async inspect(id) {
        if (failingIds.includes(id)) {
          throw new Error(`stored session "${id}" failed validation`)
        }
        return inner.inspect(id)
      },
    }
  }

  it('skips a session whose inspect throws, records it, and continues the walk', async () => {
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

  it('re-throws an inspect failure raised after the signal aborts', async () => {
    const log = new FakeLog()
    const controller = new AbortController()
    const persistence: SyncPersistence = {
      async list() { return [{ id: 's1' as SessionId }] },
      async inspect() {
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
        meta: { cwd: '/work/app', origin: 'subagent', parentSession: 'p0' },
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
 * Persistence twin for the handle generation (`dsh` 0.1.3-alpha.1 and later):
 * `list({ signal })` reports ids under `header`, and `open(id, 'read')` hands
 * back a handle whose `read()` yields the log while `header` carries the
 * identity facts. It deliberately exposes no `inspect`, so a code path that
 * fell back to the old seam would fail loudly here instead of passing.
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

describe('syncHistory over the handle persistence seam', () => {
  it('walks list({ signal }) + open/read and lands the same rows', async () => {
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

  it('prefers the handle seam when a twin carries both', async () => {
    const log = new FakeLog()
    const legacy = fakePersistence([{ id: 's1', events: [messageEventWith('legacy', 1)] }])
    const persistence: SyncPersistence = {
      ...handlePersistence([{ id: 's1', events: [messageEventWith('modern', 1)] }]),
      inspect: legacy.inspect,
    }
    const result = await syncHistory({ persistence, log })
    expect(result.added).toBe(1)
    expect(log.rows.map(row => row.requestId)).toEqual(['modern'])
  })

  it('fails loudly when the persistence exposes neither seam', async () => {
    const log = new FakeLog()
    const persistence: SyncPersistence = { async list() { return [] } }
    // A host too old or too new to read must not be reported as a run of
    // individually unreadable sessions.
    await expect(syncHistory({ persistence, log })).rejects.toThrow(/neither open\(\)/)
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
})
