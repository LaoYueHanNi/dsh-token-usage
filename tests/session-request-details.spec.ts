/**
 * The request-pool builder: scope-filter-first, dedupe-against-durable,
 * full-sequence cold-start marks, active-first panel selection, and the
 * 20-item display window that never touches the record set itself.
 */
import { describe, expect, it } from 'vitest'
import { buildSessionRequestDetails } from '../src/session-request-details.ts'
import type { RequestPricing } from '../src/session-request-details.ts'
import type { LiveAttempt } from '../src/request-observe.ts'
import type { UsageRecord } from '../src/usage-record.ts'
import { resolveRate } from '../src/pricing.ts'

const NO_PRICING: RequestPricing = { resolve: () => ({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: 0 }), rulesOf: () => undefined, ready: false }

/** A durable successful request row. */
function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: overrides.requestId ?? 'r1',
    time: overrides.time ?? 1_000,
    sessionId: overrides.sessionId ?? 's1',
    model: overrides.model ?? 'deepseek-chat',
    ...(overrides.responseModel !== undefined ? { responseModel: overrides.responseModel } : {}),
    ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides.usage !== undefined ? { usage: overrides.usage } : 'usage' in overrides ? {} : { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 } }),
    ...(overrides.kind !== undefined ? { kind: overrides.kind } : {}),
    ...(overrides.auxKind !== undefined ? { auxKind: overrides.auxKind } : {}),
    ...(overrides.interrupted === true ? { interrupted: true as const } : {}),
    ...(overrides.latencyMs !== undefined ? { latencyMs: overrides.latencyMs } : {}),
    ...(overrides.firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs: overrides.firstTokenLatencyMs } : {}),
    ...(overrides.failureCode !== undefined ? { failureCode: overrides.failureCode } : {}),
  }
}

/** A live attempt the observer would hold. */
function live(overrides: Partial<LiveAttempt> = {}): LiveAttempt {
  return {
    id: overrides.id ?? '42:s1:t1:s1:a1',
    sessionId: overrides.sessionId ?? 's1',
    kind: overrides.kind ?? 'request',
    state: overrides.state ?? 'completed',
    provider: overrides.provider ?? 'deepseek-official',
    requestedModel: overrides.requestedModel ?? 'deepseek-chat',
    startedAt: overrides.startedAt ?? 2_000,
    ...(overrides.settledAt !== undefined ? { settledAt: overrides.settledAt } : overrides.state === 'waiting' || overrides.state === 'streaming' ? {} : { settledAt: 2_100 }),
    ...(overrides.firstTokenAt !== undefined ? { firstTokenAt: overrides.firstTokenAt } : {}),
    ...(overrides.wasActive !== undefined ? { wasActive: overrides.wasActive } : {}),
    ...(overrideOrOmit(overrides)),
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    ...(overrides.durableRequestId !== undefined ? { durableRequestId: overrides.durableRequestId } : {}),
  }
}

/** Keep an explicitly-passed usage, or default one; drop the key only when
 * the test passed `usage: undefined`. */
function overrideOrOmit(overrides: Partial<LiveAttempt>): { usage?: Exclude<LiveAttempt['usage'], undefined> } {
  if ('usage' in overrides) return overrides.usage === undefined ? {} : { usage: overrides.usage }
  return { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 } }
}

describe('buildSessionRequestDetails — window and order', () => {
  it('prices durable rows at the ledger settlement time, independently of their start-order anchor', () => {
    const rates = { base: { inputPerMillion: 1, outputPerMillion: 1 }, contextTiers: [], dailySlots: [], timeRules: [{ startTime: 5, endTime: 100, rates: { inputPerMillion: 10, outputPerMillion: 10 } }] }
    const details = buildSessionRequestDetails({
      records: [{ ...record({ requestId: 'priced', time: 9_000, usage: { inputTokens: 1_000_000, outputTokens: 0 } }), startedAt: 1_000 }],
      live: { attempts: [], activeCount: 0 }, asOf: 10_000, liveCapability: 'settled-only',
      pricing: { ready: true, rulesOf: () => rates, resolve: row => resolveRate(rates, row.time, 1_000_000).key },
    })
    expect(details.items[0]!.cost).toBe(10)
    expect(details.items[0]!.orderAt).toBe(1_000)
  })

  it('does not estimate live costs or mix an unknown attempt first token with a legacy step clock', () => {
    const attempt = live({ durableRequestId: 'r1', startedAt: 2_000, settledAt: 5_000 })
    const pricing: RequestPricing = { ready: true, rulesOf: () => ({ base: { inputPerMillion: 1, outputPerMillion: 1 }, contextTiers: [], dailySlots: [], timeRules: [] }), resolve: () => ({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }) }
    const liveOnly = buildSessionRequestDetails({ records: [], live: { attempts: [attempt], activeCount: 0 }, pricing, asOf: 6_000, liveCapability: 'lifecycle' })
    expect(liveOnly.items[0]!.cost).toBeUndefined()
    const merged = buildSessionRequestDetails({ records: [record({ firstTokenLatencyMs: 500 })], live: { attempts: [attempt], activeCount: 0 }, pricing, asOf: 6_000, liveCapability: 'lifecycle' })
    expect(merged.items[0]!.firstTokenLatencyMs).toBeUndefined()
    expect(merged.items[0]!.speed).toBeUndefined()
  })

  // R01
  it('caps the pool at 20 items (1 latest + 19 history) while the record set stays whole', () => {
    const records = Array.from({ length: 40 }, (_, i) => record({ requestId: `r${String(i)}`, time: 1_000 + i }))
    const details = buildSessionRequestDetails({ records, live: { attempts: [], activeCount: 0 }, pricing: NO_PRICING, asOf: 99_000, liveCapability: 'lifecycle' })
    expect(details.items).toHaveLength(20)
    expect(details.limit).toBe(20)
    // Newest START first: the last record is the top of the pool.
    expect(details.items[0]!.id).toBe('r39')
    expect(details.items[19]!.id).toBe('r20')
  })

  it('sorts by start time, not completion time — a late finisher cannot steal the top', () => {
    // A starts earlier, B later; B finishes first (R02's shape).
    const a = live({ id: 'live-a', sessionId: 's1', startedAt: 5_000, settledAt: 9_000, state: 'completed' })
    const b = live({ id: 'live-b', sessionId: 's1', startedAt: 6_000, settledAt: 6_500, state: 'completed', turn: 1, step: 1 })
    const details = buildSessionRequestDetails({
      records: [],
      live: { attempts: [a, b], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 10_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items[0]!.id).toBe('live-b') // newest START, not newest finish
    expect(details.items[1]!.id).toBe('live-a')
  })

  it('keeps the in-flight older row generating after a newer dispatch (never auto-cancelled)', () => {
    const old = live({ id: 'live-old', state: 'streaming', startedAt: 5_000, settledAt: undefined })
    const fresh = live({ id: 'live-new', state: 'waiting', startedAt: 8_000, settledAt: undefined })
    const details = buildSessionRequestDetails({
      records: [],
      live: { attempts: [old, fresh], activeCount: 2 },
      pricing: NO_PRICING,
      asOf: 9_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items[0]!.state).toBe('waiting')
    expect(details.items[1]!.state).toBe('streaming') // still generating in place
    expect(details.activeCount).toBe(2)
  })

  it.each(['waiting', 'streaming'] as const)('promotes an older %s child over a newer completed parent', state => {
    const child = live({ id: 'active-child', sessionId: 'child', state, startedAt: 1_000, usage: undefined })
    const records = [record({ requestId: 'parent-done', time: 5_000 })]
    const details = buildSessionRequestDetails({ records, live: { attempts: [child], activeCount: 1 }, pricing: NO_PRICING, asOf: 6_000, liveCapability: 'lifecycle' })
    expect(details.items.map(item => item.id)).toEqual(['active-child', 'parent-done'])
    expect(details.items[0]).toMatchObject({ sessionId: 'child', state, elapsedMs: 5_000 })
    expect(details.items[0]!.speed).toBeUndefined()
    expect(details.activeCount).toBe(1)
  })

  it('keeps a just-completed live request in the panel for one second before history order resumes', () => {
    const completed = live({ id: 'just-done', state: 'completed', startedAt: 1_000, settledAt: 5_000, wasActive: true })
    const newer = record({ requestId: 'newer-parent', time: 5_500 })
    const build = (asOf: number) => buildSessionRequestDetails({
      records: [newer], live: { attempts: [completed], activeCount: 0 },
      pricing: NO_PRICING, asOf, liveCapability: 'lifecycle',
    })
    expect(build(5_999).items.map(item => item.id)).toEqual(['just-done', 'newer-parent'])
    expect(build(6_000).items.map(item => item.id)).toEqual(['newer-parent', 'just-done'])
  })

  it('selects the newest active attempt, hands off when it settles, then falls back to newest overall', () => {
    const older = live({ id: 'active-a', sessionId: 'child-a', state: 'streaming', startedAt: 1_000, usage: undefined })
    const newer = live({ id: 'active-b', sessionId: 'child-b', state: 'waiting', startedAt: 2_000, usage: undefined })
    const records = [record({ requestId: 'parent-done', time: 5_000 }), record({ requestId: 'earlier', time: 500 })]
    const build = (attempts: LiveAttempt[], activeCount: number) => buildSessionRequestDetails({ records, live: { attempts, activeCount }, pricing: NO_PRICING, asOf: 6_000, liveCapability: 'lifecycle' })
    expect(build([older, newer], 2).items.map(item => item.id)).toEqual(['active-b', 'parent-done', 'active-a', 'earlier'])
    const completed = { ...newer, state: 'completed' as const, settledAt: 5_500 }
    expect(build([older, completed], 1).items.map(item => item.id)).toEqual(['active-a', 'parent-done', 'active-b', 'earlier'])
    const allDone = build([{ ...older, state: 'completed', settledAt: 5_800 }, completed], 0)
    expect(allDone.items.map(item => item.id)).toEqual(['parent-done', 'active-b', 'active-a', 'earlier'])
    expect(allDone.activeCount).toBe(0)
  })

  it('reserves the panel for a long-running child before cutting the 20-item window', () => {
    const records = Array.from({ length: 25 }, (_, i) => record({ requestId: `r${String(i)}`, time: 2_000 + i }))
    const older = live({ id: 'long-child', sessionId: 'child', state: 'streaming', startedAt: 1_000, usage: undefined })
    const details = buildSessionRequestDetails({ records, live: { attempts: [older], activeCount: 1 }, pricing: NO_PRICING, asOf: 6_000, liveCapability: 'lifecycle' })
    expect(details.items).toHaveLength(20)
    expect(details.items[0]!.id).toBe('long-child')
    expect(details.items.slice(1).map(item => item.id)).toEqual(Array.from({ length: 19 }, (_, i) => `r${String(24 - i)}`))
    expect(new Set(details.items.map(item => item.id)).size).toBe(20)
    expect(details.items[1]!.cache.reason).toBeUndefined()
    expect(records).toHaveLength(25)
  })
})

describe('buildSessionRequestDetails — merge and dedupe', () => {
  // R04: the durable row wins in place — but as a FIELD merge: the live
  // attempt's start anchor and single-attempt clock survive the settlement,
  // and the row never duplicates, renames, or downgrades behind a late
  // snapshot.
  it('folds the persisted settlement into the live row: durable facts from the log, start anchor and clock from the attempt', () => {
    const details = buildSessionRequestDetails({
      records: [record({
        requestId: 'msg-1',
        time: 4_500,
        usage: { inputTokens: 120, outputTokens: 60, cacheReadTokens: 880 },
        latencyMs: 9_000, // step-level: a retried turn's whole wall time
        firstTokenLatencyMs: 4_000,
      })],
      live: {
        attempts: [{
          ...live({ id: '42:s1:t1:s1:a1', startedAt: 2_000, settledAt: 4_400, state: 'completed' }),
          durableRequestId: 'msg-1',
          latencyMs: undefined,
          firstTokenLatencyMs: undefined,
        }],
        activeCount: 0,
      },
      pricing: NO_PRICING,
      asOf: 5_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items).toHaveLength(1)
    const row = details.items[0]!
    expect(row.durableRequestId).toBe('msg-1')
    // The identity survives the settlement — the durable id the live row
    // already carried, not a rename.
    expect(row.id).toBe('msg-1')
    // The order anchor is the attempt's START, not the record's settlement
    // time (4_500): a late-finishing early request must not jump ahead.
    expect(row.orderAt).toBe(2_000)
    expect(row.orderBasis).toBe('start')
    expect(row.startedAt).toBe(2_000)
    expect(row.recordTime).toBe(4_500)
    // Token buckets are durable facts — from the log.
    expect(row.inputTokens).toBe(120)
    expect(row.outputTokens).toBe(60)
    expect(row.cacheReadTokens).toBe(880)
  })

  it('keeps the single-attempt clock across settlement: latency and speed do not grow to the step caliber', () => {
    // The observer's speed is derived in the builder from latency − first
    // token; the merge feeds it the attempt's own clock (25s total, 500ms
    // generation → 40 tok/s), never the record's step-level figures.
    const details = buildSessionRequestDetails({
      records: [record({
        requestId: 'msg-1',
        time: 30_000,
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 },
        latencyMs: 29_500, // includes a retry backoff the attempt never saw
        firstTokenLatencyMs: 28_000,
      })],
      live: {
        attempts: [{
          ...live({ id: 'a1', startedAt: 500, settledAt: 25_500, state: 'completed', turn: 1, step: 1, firstTokenAt: 5_000 }),
          durableRequestId: 'msg-1',
        }],
        activeCount: 0,
      },
      pricing: NO_PRICING,
      asOf: 31_000,
      liveCapability: 'lifecycle',
    })
    const row = details.items[0]!
    expect(row.latencyMs).toBe(25_000) // live: settledAt − startedAt
    expect(row.firstTokenLatencyMs).toBe(4_500) // live clock, not 28_000
    expect(row.speed).toBeCloseTo(20 / (25_000 - 4_500) * 1_000, 6)
  })

  it('keeps start order through the whole live → logged → reloaded cycle (a late-settling early request stays below later ones)', () => {
    // The reviewer's repro: A starts first and finishes LAST; B starts
    // later and settles first. Across all four snapshots A never climbs
    // above B.
    const aLive = (durableRequestId: string): LiveAttempt => ({
      ...live({ id: 'a', startedAt: 5_000, settledAt: 9_000, state: 'completed' }),
      durableRequestId,
    })
    const bRecord = record({ requestId: 'msg-b', time: 6_500, usage: { inputTokens: 10, outputTokens: 5 } })

    // 1. Both running (neither settled a durable id yet): B newer, on top.
    const running = buildSessionRequestDetails({
      records: [],
      live: { attempts: [live({ id: 'a', startedAt: 5_000, settledAt: 9_000, state: 'completed' }), live({ id: 'b', startedAt: 6_000, settledAt: 6_400, state: 'completed' })], activeCount: 0 },
      pricing: NO_PRICING, asOf: 7_000, liveCapability: 'lifecycle',
    })
    expect(running.items.map(item => item.id)).toEqual(['b', 'a'])

    // 2. A settles (durable id linked), its row not in the log yet.
    const settled = buildSessionRequestDetails({
      records: [bRecord],
      live: { attempts: [aLive('msg-a')], activeCount: 0 },
      pricing: NO_PRICING, asOf: 9_500, liveCapability: 'lifecycle',
    })
    expect(settled.items.map(item => item.id)).toEqual(['msg-b', 'msg-a'])

    // 3. The log landed both rows — the merge folds A's persisted row into
    //    the live attempt in place: no reorder, no second row.
    const aRecord = record({ requestId: 'msg-a', time: 9_000, usage: { inputTokens: 10, outputTokens: 5 } })
    const logged = buildSessionRequestDetails({
      records: [bRecord, aRecord],
      live: { attempts: [aLive('msg-a')], activeCount: 0 },
      pricing: NO_PRICING, asOf: 9_600, liveCapability: 'lifecycle',
    })
    expect(logged.items).toHaveLength(2)
    expect(logged.items.map(item => item.id)).toEqual(['msg-b', 'msg-a'])

    // 4. Reload: records only (no live observer), and the rows carry the
    //    recorded start anchors — still start order, not settlement order.
    const reloaded = buildSessionRequestDetails({
      records: [
        { ...bRecord, startedAt: 6_000 },
        { ...aRecord, startedAt: 5_000 },
      ],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING, asOf: 9_700, liveCapability: 'settled-only',
    })
    expect(reloaded.items.map(item => item.id)).toEqual(['msg-b', 'msg-a'])
    // Legacy rows without startedAt still sort by their (only) anchor.
    const legacy = buildSessionRequestDetails({
      records: [aRecord, bRecord],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING, asOf: 9_700, liveCapability: 'settled-only',
    })
    expect(legacy.items.map(item => item.id)).toEqual(['msg-a', 'msg-b'])
  })

  it('keeps an acknowledged cancellation cancelled after its partial settlement lands (never rebranded 连接中断)', () => {
    // Live: the user's stop observed at the waterfall. Logged: the host
    // finalized the delivered prefix as assistant/message with
    // `interrupted: true`. The merged row — and the reloaded one — stay
    // cancelled.
    const recordRow = record({ requestId: 'msg-part', time: 3_000, interrupted: true, usage: { inputTokens: 10, outputTokens: 3 } })
    const merged = buildSessionRequestDetails({
      records: [recordRow],
      live: { attempts: [{ ...live({ id: 'a1', state: 'cancelled', startedAt: 2_000, settledAt: 2_900 }), durableRequestId: 'msg-part' }], activeCount: 0 },
      pricing: NO_PRICING, asOf: 4_000, liveCapability: 'lifecycle',
    })
    expect(merged.items[0]!.state).toBe('cancelled')
    const reloaded = buildSessionRequestDetails({
      records: [recordRow],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING, asOf: 4_000, liveCapability: 'settled-only',
    })
    expect(reloaded.items[0]!.state).toBe('cancelled')
  })

  it('folds retried-failure and compaction settlements into their live rows without growing a second row', () => {
    // One failed attempt (llm/retry row) and one compaction summarize
    // (compaction/summary row): the linked live attempts merge into the
    // logged rows in place — no duplicate rows, no double-billed compaction.
    const failureRecord = record({ requestId: 'failure:s1:8', kind: 'failure', time: 2_100, model: 'deepseek-chat', failureCode: 'RATE_LIMIT', usage: undefined })
    const compactionRecord = record({ requestId: 'compaction:s1:7', kind: 'compaction', time: 5_000, model: 'deepseek-chat', usage: { inputTokens: 100_000, outputTokens: 500 } })
    const details = buildSessionRequestDetails({
      records: [failureRecord, compactionRecord],
      live: {
        attempts: [
          { ...live({ id: 'a1', state: 'failed', startedAt: 2_000, settledAt: 2_050, failureCode: 'RATE_LIMIT' }), durableRequestId: 'failure:s1:8' },
          { ...live({ id: 'c1', kind: 'compaction', state: 'completed', startedAt: 4_000, settledAt: 4_900 }), durableRequestId: 'compaction:s1:7' },
        ],
        activeCount: 0,
      },
      pricing: NO_PRICING,
      asOf: 6_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items).toHaveLength(2)
    expect(details.items.map(item => item.id).sort()).toEqual(['compaction:s1:7', 'failure:s1:8'])
    expect(details.items.find(item => item.id === 'failure:s1:8')!.state).toBe('failed')
    expect(details.items.find(item => item.id === 'compaction:s1:7')!.kind).toBe('compaction')
  })

  it('keeps the live terminal state while the persisted row has not landed yet', () => {
    const details = buildSessionRequestDetails({
      records: [],
      live: { attempts: [live({ id: 'live-x', state: 'cancelled', startedAt: 2_000, settledAt: 2_400 })], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 3_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items).toHaveLength(1)
    expect(details.items[0]!.state).toBe('cancelled')
  })

  // R05: three real attempts = three rows; the scope cut happens before the
  // window (R07) — a child's rows show in tree scope only.
  it('filters by scope first and counts every retry attempt as its own row', () => {
    const records = [
      record({ requestId: 'f1', kind: 'failure', time: 1_000, failureCode: 'RATE_LIMIT', usage: undefined }),
      record({ requestId: 'f2', kind: 'failure', time: 1_500, failureCode: 'RATE_LIMIT', usage: undefined }),
      record({ requestId: 'ok', time: 2_000 }),
      record({ requestId: 'child', sessionId: 'child', time: 2_500 }),
    ]
    const details = buildSessionRequestDetails({
      records: records.filter(r => r.sessionId === 's1'),
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 3_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items.map(item => item.id)).toEqual(['ok', 'f2', 'f1'])
    // The child row was never in the input: scope filtering is the caller's
    // contract, and the builder never reaches beyond it.
  })
})

describe('buildSessionRequestDetails — derived figures', () => {
  it('keeps an attributed auxiliary row in the pool without a cache-low assessment', () => {
    const details = buildSessionRequestDetails({
      records: [record({
        requestId: 'aux:session-title:1:1',
        kind: 'aux',
        auxKind: 'session-title',
        usage: { inputTokens: 9_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 300 },
      })],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 2_000,
      liveCapability: 'settled-only',
    })
    expect(details.items[0]).toMatchObject({ kind: 'aux', auxKind: 'session-title', cache: { band: 'excluded', reason: 'auxiliary' } })
  })

  it('publishes the pricing-resolved model id for request-pool display', () => {
    const details = buildSessionRequestDetails({
      records: [record({ requestId: 'alias', model: 'group/glm-5.3-flashx' })],
      live: { attempts: [], activeCount: 0 },
      pricing: { ...NO_PRICING, modelIdOf: name => name === 'group/glm-5.3-flashx' ? 'glm-5.3-flashx' : name },
      asOf: 2_000,
      liveCapability: 'settled-only',
    })
    expect(details.items[0]!.modelId).toBe('glm-5.3-flashx')
    expect(details.items[0]!.requestedModel).toBe('group/glm-5.3-flashx')
  })

  it.each(['zai-coding-cn', undefined])('assesses reported cache data on %s after the cold-start request', provider => {
    const details = buildSessionRequestDetails({
      records: [
        record({ requestId: 'first', time: 1_000, provider }),
        record({ requestId: 'next', time: 2_000, provider, usage: { inputTokens: 9_000, outputTokens: 50, cacheReadTokens: 1_000 } }),
      ],
      live: { attempts: [], activeCount: 0 }, pricing: NO_PRICING, asOf: 3_000, liveCapability: 'lifecycle',
    })
    expect(details.items[0]!.cache).toMatchObject({ rate: 0.1, band: 'loss', eligibility: 'eligible' })
    expect(details.items[0]!.cache.reason).toBeUndefined()
    expect(details.items[1]!.cache.reason).toBe('cold-start')
  })

  it('derives the settled speed server-side and the elapsed for in-flight rows', () => {
    const settled = live({ id: 'live-ok', startedAt: 1_000, settledAt: 3_000, usage: { inputTokens: 10, outputTokens: 300, cacheReadTokens: 0 } })
    // Latency/first-token live on the merged attempt via settledAt math only
    // for live rows that observed both; feed the record path for the gate:
    const details = buildSessionRequestDetails({
      records: [record({ requestId: 'r-timed', time: 500, latencyMs: 2_000, firstTokenLatencyMs: 500, usage: { inputTokens: 10, outputTokens: 300, cacheReadTokens: 0 } })],
      live: { attempts: [live({ id: 'live-wait', state: 'waiting', startedAt: 2_500, settledAt: undefined })], activeCount: 1 },
      pricing: NO_PRICING,
      asOf: 4_000,
      liveCapability: 'lifecycle',
    })
    const timed = details.items.find(item => item.id === 'r-timed')!
    expect(timed.speed).toBe(200) // 300 tokens over 1500ms generation
    const waiting = details.items.find(item => item.id === 'live-wait')!
    expect(waiting.elapsedMs).toBe(1_500) // asOf-anchored, no client clock
    expect(waiting.speed).toBeUndefined()
    expect(settled.id).toBe('live-ok')
  })

  it('marks the session first request cold-start across the FULL scope, not the window', () => {
    // 25 records: the cold start fell out of the 20-item window long ago,
    // but a brand-new model's FIRST appearance inside the window is a
    // model-switch, and the session's true first row is outside anyway.
    const records = [
      record({ requestId: 'first', time: 1_000 }), // the real cold start
      ...Array.from({ length: 24 }, (_, i) => record({ requestId: `r${String(i)}`, time: 2_000 + i, model: 'deepseek-chat' })),
    ]
    const details = buildSessionRequestDetails({
      records,
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 99_000,
      liveCapability: 'lifecycle',
    })
    // Nothing in the window carries a sequence exclusion — the marks came
    // from the full scope (the first row, outside the window, holds the
    // cold-start), never from window positions (C08's shape).
    expect(details.items.every(item => item.cache.reason !== 'cold-start' && item.cache.reason !== 'model-switch')).toBe(true)
  })

  it('marks a model switch seen inside the merged sequence', () => {
    const details = buildSessionRequestDetails({
      records: [
        record({ requestId: 'a', time: 1_000, model: 'deepseek-chat', provider: 'deepseek-official' }),
        record({ requestId: 'b', time: 2_000, model: 'deepseek-chat', provider: 'deepseek-official', usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 100 } }),
      ],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 3_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items[0]!.cache.reason).toBeUndefined() // b: same route, assessable
    expect(details.items[1]!.cache.reason).toBe('cold-start') // a is the first
    // And a same-route 9% hit labels loss once eligibility evidence exists.
    const withSwitch = buildSessionRequestDetails({
      records: [
        record({ requestId: 'a', time: 1_000, model: 'deepseek-chat', provider: 'deepseek-official' }),
        record({ requestId: 'b', time: 2_000, model: 'glm-5.3', provider: 'deepseek-official', usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 100 } }),
      ],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 3_000,
      liveCapability: 'lifecycle',
    })
    expect(withSwitch.items[0]!.cache.reason).toBe('model-switch')
    expect(withSwitch.items[0]!.cache.band).toBe('excluded')
  })

  it('responds with cancelled for an interrupted durable row (an acknowledged user cancel) and failed for failure rows', () => {
    const details = buildSessionRequestDetails({
      records: [
        record({ requestId: 'partial', time: 1_000, interrupted: true, usage: { inputTokens: 10, outputTokens: 3 } }),
        record({ requestId: 'boom', kind: 'failure', time: 2_000, failureCode: 'TRANSPORT', usage: undefined }),
      ],
      live: { attempts: [], activeCount: 0 },
      pricing: NO_PRICING,
      asOf: 3_000,
      liveCapability: 'lifecycle',
    })
    expect(details.items[0]!.state).toBe('failed')
    expect(details.items[0]!.failureCode).toBe('TRANSPORT')
    expect(details.items[0]!.pricingStatus).toBe('unknown')
    // `interrupted: true` on the durable row means the host finalized a
    // mid-stream-cancelled turn's delivered prefix — an acknowledged cancel,
    // never rebranded into 连接中断 after landing.
    expect(details.items[1]!.state).toBe('cancelled')
    expect(details.items[1]!.cache.band).toBe('excluded')
    expect(details.items[1]!.cache.reason).toBe('not-success')
  })
})
