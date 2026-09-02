import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type { UsageLog } from '../src/usage-log.ts'
import { autoSyncIfNeeded, syncHistory, type SyncPersistence } from '../src/sync.ts'
import { isInitialized } from '../src/sync-state.ts'
import { messageEvent } from './helpers.ts'

function fakePersistence(sessions: Array<{ id: string; events: SessionEvent[] }>): SyncPersistence {
  return {
    async list() {
      return sessions.map(session => ({ header: { id: session.id as SessionId } }))
    },
    async open(id) {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return {
        async read(offset = 0) {
          return session.events.slice(offset)
        },
        async close() {},
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
    expect(result).toEqual({ added: 3, skipped: 0 })
  })

  it('ignores non-assistant/message events', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([
      {
        id: 's1',
        events: [
          { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } } as SessionEvent,
          messageEventWith('m1', 1),
          { type: 'assistant/chunk', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } } as SessionEvent,
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
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1 })
  })

  it('dedupes rows found in the data files via scan', async () => {
    const log = new FakeLogWithFile()
    await log.seedFile('m1')
    const persistence = fakePersistence([{ id: 's1', events: [messageEventWith('m1', 1), messageEventWith('m2', 2)] }])
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 1 })
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
    expect(result).toEqual({ added: 1, skipped: 0 })
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
    const ticks: Array<{ processed: number; total: number; added: number; skipped: number }> = []
    const result = await syncHistory({ persistence, log },
      tick => { ticks.push({ ...tick }) },
    )
    expect(result).toEqual({ added: 3, skipped: 0 })
    // One leading tick at processed: 0, then one per session.
    expect(ticks).toEqual([
      { processed: 0, total: 2, added: 0, skipped: 0 },
      { processed: 1, total: 2, added: 1, skipped: 0 },
      { processed: 2, total: 2, added: 3, skipped: 0 },
    ])
  })

  it('reports total: 0 when the persistence lists no sessions', async () => {
    const log = new FakeLog()
    const persistence = fakePersistence([])
    const ticks: number[] = []
    const result = await syncHistory({ persistence, log },
      tick => { ticks.push(tick.total) },
    )
    expect(result).toEqual({ added: 0, skipped: 0 })
    expect(ticks).toEqual([0])
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
