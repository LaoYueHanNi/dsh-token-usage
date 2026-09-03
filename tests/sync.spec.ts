import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { UsageLog } from '../src/usage-log.ts'
import { autoSyncIfNeeded, syncHistory, type SyncPersistence } from '../src/sync.ts'
import { isInitialized } from '../src/sync-state.ts'
import { compactionEvent, messageEvent, retryEvent, turnEndEvent } from './helpers.ts'

function fakePersistence(sessions: Array<{ id: string; events: SessionEvent[] }>): SyncPersistence {
  return {
    async list() {
      return sessions.map(session => ({ id: session.id as SessionId }))
    },
    async inspect(id) {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return { events: session.events }
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
    expect(result).toEqual({ added: 3, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 1, skipped: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('dedupes rows already written this process', async () => {
    const log = new FakeLog()
    await log.recordRow('m1')
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1, failedSessions: 0 })
  })

  it('dedupes rows found in the data files via scan', async () => {
    const log = new FakeLogWithFile()
    await log.seedFile('m1')
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1, failedSessions: 0 })
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
    expect(result).toEqual({ added: 2, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 2, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 3, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 2, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 1, skipped: 0, failedSessions: 0 })
    expect(log.rows.map(row => row.requestId)).toEqual(['failure:s1:4'])
  })

  it('dedupes retry failure rows across repeated syncs', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [retryEvent({ seq: 4 })] as SessionEvent[] },
    ])
    await syncHistory({ persistence, log })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 1, failedSessions: 0 })
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
    expect(result).toEqual({ added: 0, skipped: 0, failedSessions: 0 })
    expect(log.rows).toHaveLength(0)
  })

  it('dedupes failure rows across repeated syncs', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      { id: 's1', events: [turnEndEvent({ seq: 5 })] as SessionEvent[] },
    ])
    await syncHistory({ persistence, log })
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 1, failedSessions: 0 })
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
    expect(result).toEqual({ added: 1, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 0, skipped: 2, failedSessions: 0 })
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
    expect(result).toEqual({ added: 1, skipped: 0, failedSessions: 0 })
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
    expect(result).toEqual({ added: 1, skipped: 0, failedSessions: 0 })
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
    const ticks: Array<{ processed: number; total: number; added: number; skipped: number; failedSessions: number }> = []
    const result = await syncHistory({ persistence, log },
      tick => { ticks.push({ ...tick }) },
    )
    expect(result).toEqual({ added: 3, skipped: 0, failedSessions: 0 })
    // One leading tick at processed: 0, then one per session.
    expect(ticks).toEqual([
      { processed: 0, total: 2, added: 0, skipped: 0, failedSessions: 0 },
      { processed: 1, total: 2, added: 1, skipped: 0, failedSessions: 0 },
      { processed: 2, total: 2, added: 3, skipped: 0, failedSessions: 0 },
    ])
  })

  it('reports total: 0 when the persistence lists no sessions', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([])
    const ticks: number[] = []
    const result = await syncHistory({ persistence, log },
      tick => { ticks.push(tick.total) },
    )
    expect(result).toEqual({ added: 0, skipped: 0, failedSessions: 0 })
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
    const ticks: Array<{ processed: number; total: number; failedSessions: number }> = []
    const result = await syncHistory({ persistence, log,
        onSessionFailure: (id, error) => { failures.push({ id, message: error instanceof Error ? error.message : String(error) }) } },
      tick => { ticks.push({ processed: tick.processed, total: tick.total, failedSessions: tick.failedSessions }) },
    )
    // The readable sessions still land; the broken one is counted, reported,
    // and progresses the bar so it always reaches `total`.
    expect(result).toEqual({ added: 3, skipped: 0, failedSessions: 1 })
    expect(log.rows.map(row => row.requestId).sort()).toEqual(['m2', 'm3', 'm4'])
    expect(failures).toEqual([{ id: 'broken', message: 'stored session "broken" failed validation' }])
    expect(ticks.map(tick => tick.failedSessions)).toEqual([0, 1, 1, 1])
    expect(ticks.at(-1)).toEqual({ processed: 3, total: 3, failedSessions: 1 })
  })

  it('keeps the run alive when every session fails, then succeeds again', async () => {
    const log = new FakeLog()
    const persistence = persistenceWithFailures([
      { id: 'a', events: [] },
      { id: 'b', events: [] },
    ], ['a', 'b'])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 0, skipped: 0, failedSessions: 2 })
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
