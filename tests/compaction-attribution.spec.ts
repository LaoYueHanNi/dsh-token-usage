import { describe, expect, it } from 'vitest'
import { type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { CompactionAttributionWindow } from '../src/compaction-attribution.ts'
import { syncHistory, type SyncLog, type SyncPersistence } from '../src/sync.ts'
import { buildSessionRequestDetails } from '../src/session-request-details.ts'
import { parseRecord, type UsageRecord } from '../src/usage-record.ts'
import { compactionEvent, messageEvent, pruneEvent, turnEndEvent } from './helpers.ts'

describe('CompactionAttributionWindow', () => {
  it('folds a tight prune run at one step boundary into one cluster', () => {
    const window = new CompactionAttributionWindow()
    for (let index = 0; index < 9; index += 1) {
      window.observe(pruneEvent({ seq: 20 + index, tokens: 3_000 + index }))
    }
    expect(window.consumeForRequest()).toEqual([
      { kind: 'prune', count: 9, shadowedTokenCount: 27_036 },
    ])
    // The window reset with the consumption.
    expect(window.consumeForRequest()).toBeUndefined()
  })

  it('keeps one cluster across interleaved non-compaction events (real batch shape)', () => {
    // Real session shape (50e782ce): a prune batch interleaves with the
    // step's straggling tool/result appends at one step boundary —
    // step/end, then prune / tool/result alternating six times, then
    // step/start. The whole batch stays ONE cluster.
    const window = new CompactionAttributionWindow()
    const toolResult = { type: 'tool/result', seq: 0, time: 1, data: { message: { role: 'user', content: [], toolCallId: 'c1' } } } as unknown as SessionEvent
    window.observe({ type: 'step/end', seq: 96, time: 1, data: { turn: 1, step: 3 } } as SessionEvent)
    for (let index = 0; index < 6; index += 1) {
      window.observe(pruneEvent({ seq: 97 + index * 2, tokens: 1_000 + index }))
      window.observe(toolResult)
    }
    window.observe({ type: 'step/start', seq: 109, time: 2, data: { turn: 1, step: 4 } } as SessionEvent)
    expect(window.consumeForRequest()).toEqual([
      { kind: 'prune', count: 6, shadowedTokenCount: 6_015 },
    ])
  })

  it('separates the clusters around a summary (prune → summary → prune)', () => {
    const window = new CompactionAttributionWindow()
    window.observe(pruneEvent({ seq: 10, tokens: 100 }))
    window.observe(pruneEvent({ seq: 11, tokens: 20 }))
    window.observe(compactionEvent({ seq: 12 }))
    window.observe(pruneEvent({ seq: 13, tokens: 5 }))
    expect(window.consumeForRequest()).toEqual([
      { kind: 'prune', count: 2, shadowedTokenCount: 120 },
      { kind: 'summary', count: 1, shadowedTokenCount: 123_456 },
      { kind: 'prune', count: 1, shadowedTokenCount: 5 },
    ])
  })

  it('reads a malformed shadow figure as 0 (the event count is still a fact)', () => {
    const window = new CompactionAttributionWindow()
    window.observe(pruneEvent({ seq: 10, tokens: Number.NaN }))
    const hostile = pruneEvent({ seq: 11 })
    ;(hostile.data as Record<string, unknown>).shadowedTokenCount = -4
    window.observe(hostile)
    expect(window.consumeForRequest()).toEqual([{ kind: 'prune', count: 2, shadowedTokenCount: 0 }])
  })

  it('returns undefined while empty and resets after a consumption', () => {
    const window = new CompactionAttributionWindow()
    window.observe(messageEvent({ messageId: 'm1', seq: 1 }))
    expect(window.consumeForRequest()).toBeUndefined()
    window.observe(compactionEvent({ seq: 2 }))
    expect(window.consumeForRequest()).toEqual([{ kind: 'summary', count: 1, shadowedTokenCount: 123_456 }])
  })
})

/** In-memory UsageLog twin capturing rows for assertions. */
class FakeLog implements SyncLog {
  readonly rows: UsageRecord[] = []
  private readonly seen = new Set<string>()

  async scan(): Promise<void> {}

  ids(): ReadonlySet<string> {
    return new Set(this.seen)
  }

  record(row: UsageRecord): Promise<boolean> {
    if (this.seen.has(row.requestId)) return Promise.resolve(false)
    this.seen.add(row.requestId)
    this.rows.push(row)
    return Promise.resolve(true)
  }

  reconcile(): Promise<number> {
    return Promise.resolve(0)
  }
}

function fakePersistence(events: readonly SessionEvent[]): SyncPersistence {
  const session = { id: 's1', events }
  return {
    async list() {
      return [{ header: { id: session.id as SessionId } }]
    },
    async open() {
      return {
        read() { return Promise.resolve({ events: session.events }) },
        close() { return Promise.resolve() },
      }
    },
  }
}

describe('sync attribution (history path)', () => {
  it('attributes the first plain request after a prune run and resets for the next', async () => {
    const log = new FakeLog()
    const events: SessionEvent[] = [
      messageEvent({ messageId: 'm1', seq: 250 }),
      ...Array.from({ length: 9 }, (_, index) => pruneEvent({ seq: 260 + index, tokens: 3_581 })),
      messageEvent({ messageId: 'm2', seq: 284 }),
      messageEvent({ messageId: 'm3', seq: 300 }),
    ]
    await syncHistory({ persistence: fakePersistence(events), log })
    const byId = new Map(log.rows.map(row => [row.requestId, row]))
    expect(byId.get('m1')!.compactionAttribution).toBeUndefined()
    expect(byId.get('m2')!.compactionAttribution).toEqual([
      { kind: 'prune', count: 9, shadowedTokenCount: 32_229 },
    ])
    expect(byId.get('m3')!.compactionAttribution).toBeUndefined()
  })

  it('attributes a summary rewrite while the compaction row itself stays unattributed', async () => {
    const log = new FakeLog()
    const events: SessionEvent[] = [
      messageEvent({ messageId: 'm1', seq: 400 }),
      compactionEvent({ seq: 410 }),
      messageEvent({ messageId: 'm2', seq: 414 }),
    ]
    await syncHistory({ persistence: fakePersistence(events), log })
    const byId = new Map(log.rows.map(row => [row.requestId, row]))
    const compactionRow = byId.get('compaction:s1:410')!
    expect(compactionRow.kind).toBe('compaction')
    expect(compactionRow.compactionAttribution).toBeUndefined()
    expect(byId.get('m2')!.compactionAttribution).toEqual([
      { kind: 'summary', count: 1, shadowedTokenCount: 123_456 },
    ])
  })

  it('keeps the window across failure rows and attributes the next plain request', async () => {
    const log = new FakeLog()
    const events: SessionEvent[] = [
      messageEvent({ messageId: 'm1', seq: 1 }),
      pruneEvent({ seq: 2, tokens: 900 }),
      turnEndEvent({ seq: 3 }),
      messageEvent({ messageId: 'm2', seq: 4 }),
    ]
    await syncHistory({ persistence: fakePersistence(events), log })
    const byId = new Map(log.rows.map(row => [row.requestId, row]))
    const failureRow = byId.get('failure:s1:3')!
    expect(failureRow.kind).toBe('failure')
    expect(failureRow.compactionAttribution).toBeUndefined()
    expect(byId.get('m2')!.compactionAttribution).toEqual([
      { kind: 'prune', count: 1, shadowedTokenCount: 900 },
    ])
  })

  it('still folds summary rewrites into the window when compaction recording is off', async () => {
    const log = new FakeLog()
    const events: SessionEvent[] = [
      messageEvent({ messageId: 'm1', seq: 1 }),
      compactionEvent({ seq: 2 }),
      messageEvent({ messageId: 'm2', seq: 3 }),
    ]
    await syncHistory({ persistence: fakePersistence(events), log, recordCompaction: false })
    expect(log.rows.map(row => row.requestId)).toEqual(['m1', 'm2'])
    expect(log.rows[1]!.compactionAttribution).toEqual([
      { kind: 'summary', count: 1, shadowedTokenCount: 123_456 },
    ])
  })
})

describe('attribution round-trip and projection', () => {
  it('round-trips the attribution through parseRecord', () => {
    const record = parseRecord(JSON.stringify({
      requestId: 'm1', time: 1, sessionId: 's1', model: 'deepseek-chat',
      compactionAttribution: [
        { kind: 'prune', count: 2, shadowedTokenCount: 4_812 },
        { kind: 'summary', count: 1, shadowedTokenCount: 2_623 },
      ],
    }))!
    expect(record.compactionAttribution).toEqual([
      { kind: 'prune', count: 2, shadowedTokenCount: 4_812 },
      { kind: 'summary', count: 1, shadowedTokenCount: 2_623 },
    ])
  })

  it('drops malformed attribution entries individually and an empty survivor set', () => {
    const record = parseRecord(JSON.stringify({
      requestId: 'm1', time: 1, sessionId: 's1', model: 'deepseek-chat',
      compactionAttribution: [
        { kind: 'prune', count: 2, shadowedTokenCount: 4_812 },
        { kind: 'melt', count: 1, shadowedTokenCount: 10 },
        { kind: 'prune', count: 0, shadowedTokenCount: 10 },
        { kind: 'summary', count: 1, shadowedTokenCount: -1 },
        'nonsense',
      ],
    }))!
    expect(record.compactionAttribution).toEqual([
      { kind: 'prune', count: 2, shadowedTokenCount: 4_812 },
    ])
    const none = parseRecord(JSON.stringify({
      requestId: 'm2', time: 1, sessionId: 's1', model: 'deepseek-chat',
      compactionAttribution: [],
    }))!
    expect('compactionAttribution' in none).toBe(false)
  })

  it('carries the attribution onto the request-pool view from the durable row', () => {
    const pricing = { ready: false, rulesOf: () => undefined, resolve: () => ({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: 0 }) }
    const attribution = [{ kind: 'prune', count: 2, shadowedTokenCount: 4_812 }]
    const details = buildSessionRequestDetails({
      records: [{ requestId: 'm1', time: 2_000, sessionId: 's1', model: 'deepseek-chat', compactionAttribution: attribution }],
      live: { attempts: [], activeCount: 0 },
      pricing,
      asOf: 3_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items[0]!.compactionAttribution).toEqual(attribution)
  })
})
