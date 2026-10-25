import { mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRollup, writeRollup, ROLLUP_AGGREGATE_FORMAT } from '../src/rollup.ts'
import { clearRecordCache, readCachedRecords } from '../src/record-cache.ts'
import { RECENT_LIMIT, attachCosts, buildSummary, filterRecordsBySessions, filterSummary, mergeSummaries, readAllRecords, requestSeriesOf, summarizeRecords } from '../src/stats.ts'
import type { RateResolver } from '../src/stats.ts'
import type { PricingTable } from '../src/wire.ts'
import type { UsageRecord } from '../src/usage-record.ts'

/** One record with the given time and usage buckets (usage optional); pass
 * `kind: 'compaction'` for a compaction summarize row, `kind: 'failure'`
 * for a failed-request row (no usage by construction). */
function record(time: number, model: string, usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, kind?: 'compaction' | 'failure'): UsageRecord {
  return {
    requestId: kind === 'compaction' ? `compaction-${time}`
      : kind === 'failure' ? `failure-${time}-${model}`
        : `req-${time}-${model}`,
    time,
    sessionId: 's1',
    model,
    ...(kind !== undefined ? { kind } : {}),
    ...usage === undefined || kind === 'failure' ? {} : {
      usage: {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        ...usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead },
        ...usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite },
      },
    },
  }
}

describe('summarizeRecords', () => {
  it('folds a host-attributed auxiliary request into its session while keeping unowned aux global', () => {
    const owned: UsageRecord = {
      requestId: 'aux:session-title:1:1', time: 1_700_000_000_000, sessionId: 's1', model: 'title-model',
      kind: 'aux', auxKind: 'session-title', usage: { inputTokens: 20, outputTokens: 4 },
    }
    const unowned: UsageRecord = { ...owned, requestId: 'aux:auto-review:1:2', sessionId: '', auxKind: 'auto-review' }
    const summary = summarizeRecords([owned, unowned])
    expect(summary.total.requests).toBe(2)
    expect(summary.bySession).toHaveLength(1)
    expect(summary.bySession[0]!.sessionId).toBe('s1')
    expect(summary.bySession[0]!.totals.requests).toBe(1)
    expect(summary.auxRows).toHaveLength(2)
  })

  it('groups every model dimension under the provider-reported response model first', () => {
    const at = new Date(2026, 0, 15, 12).getTime()
    const summary = summarizeRecords([
      { ...record(at, 'auto/GLM-5.3-Flash', { input: 10, output: 5 }), responseModel: 'glm-5.3-flash' },
      { ...record(at + 1, 'zcode/GLM-5.3-Flash', { input: 1, output: 1 }), responseModel: 'glm-5.3-flash' },
    ])
    // Both routed aliases fold onto one row under the reported name — no
    // provider-prefix stripping or alias regex needed for the grouping key.
    expect(summary.byModel.map(row => row.model)).toEqual(['glm-5.3-flash'])
    expect(summary.byModel[0]!.totals.requests).toBe(2)
    expect(summary.byHour[0]!.model).toBe('glm-5.3-flash')
    expect(summary.rateRows[0]!.model).toBe('glm-5.3-flash')
    expect(summary.bySession[0]!.model).toBe('glm-5.3-flash')
    // The recent window keeps the raw record untouched (both names present).
    expect(summary.recent[0]).toMatchObject({ model: 'zcode/GLM-5.3-Flash', responseModel: 'glm-5.3-flash' })
  })

  it('falls back to the routed name when the adapter reported no response model', () => {
    const at = new Date(2026, 0, 15, 12).getTime()
    const summary = summarizeRecords([
      record(at, 'auto/GLM-5.3-Flash', { input: 10, output: 5 }),
    ])
    expect(summary.byModel.map(row => row.model)).toEqual(['auto/GLM-5.3-Flash'])
  })

  it('matches the model filter against the effective name on record-filtered reads', () => {
    const at = new Date(2026, 0, 15, 12).getTime()
    const records: UsageRecord[] = [
      { ...record(at, 'auto/GLM-5.3-Flash', { input: 10, output: 5 }), responseModel: 'glm-5.3-flash' },
      record(at + 1, 'deepseek-chat', { input: 1, output: 1 }),
    ]
    const summary = summarizeRecords(records)
    const filtered = filterSummary({ dataDir: '/x', ...summary }, undefined, undefined, 'glm-5.3-flash')
    expect(filtered.byModel.map(row => row.model)).toEqual(['glm-5.3-flash'])
    expect(filtered.total.requests).toBe(1)
    // The recent window's record-level filter walks the same effective name.
    expect(requestSeriesOf(records, undefined, undefined, 'glm-5.3-flash')).toHaveLength(1)
  })

  it('folds a failure record into the failures dimension only, never requests', () => {
    const summary = summarizeRecords([
      record(1_700_000_000_000, 'deepseek-chat', { input: 10, output: 5 }),
      { ...record(1_700_000_000_001, 'deepseek-chat', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
      record(1_700_000_000_002, 'deepseek-reasoner', { input: 1, output: 1 }),
    ])
    // requests stays the successful count; failures counts its own rows.
    expect(summary.total.requests).toBe(2)
    expect(summary.total.failures).toBe(1)
    expect(summary.total.inputTokens).toBe(11)
    // The failure code folds into the per-code breakdown.
    expect(summary.total.failuresByCode).toEqual({ RATE_LIMIT: 1 })
    // Every dimension carries the failure count alongside its rows.
    expect(summary.byDay[0]!.totals.failures).toBe(1)
    expect(summary.byHour[0]!.totals.failures).toBe(1)
    expect(summary.byModel.find(row => row.model === 'deepseek-chat')!.totals.failures).toBe(1)
    expect(summary.rateRows[0]!.totals.failures).toBe(1)
    // The recent window carries the failure row verbatim (newest first).
    expect(summary.recent[1]).toMatchObject({ kind: 'failure', model: 'deepseek-chat' })
  })

  it('keeps an unattributed failure out of byModel and byHour', () => {
    const at = new Date(2026, 0, 15, 12).getTime()
    const summary = summarizeRecords([
      record(at, 'deepseek-chat', { input: 10, output: 5 }),
      { ...record(at + 1, '', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
    ])
    expect(summary.total.failures).toBe(1)
    expect(summary.byDay[0]!.totals.failures).toBe(1)
    expect(summary.byModel.map(row => row.model)).toEqual(['deepseek-chat'])
    expect(summary.byHour).toHaveLength(1)
    expect(summary.rateRows.some(row => row.model === '')).toBe(true)
    // Day-range filter rebuilds totals from rateRows, so the unattributed
    // failure must still be in rateRows or the count would vanish.
    const filtered = filterSummary({ dataDir: '/x', ...summary }, '2026-01-15', '2026-01-15')
    expect(filtered.total.failures).toBe(1)
    expect(filtered.byModel.map(row => row.model)).toEqual(['deepseek-chat'])
  })

  it('breaks failures down by code, defaulting a missing code to UNKNOWN', () => {
    const summary = summarizeRecords([
      { ...record(1_700_000_000_000, 'deepseek-chat', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
      { ...record(1_700_000_000_001, 'deepseek-chat', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
      { ...record(1_700_000_000_002, 'deepseek-chat', undefined, 'failure'), failureCode: 'TRANSPORT' },
      record(1_700_000_000_003, 'deepseek-chat', undefined, 'failure'),
    ])
    expect(summary.total.failures).toBe(4)
    expect(summary.total.failuresByCode).toEqual({ RATE_LIMIT: 2, TRANSPORT: 1, UNKNOWN: 1 })
    // The breakdown rides every dimension row, not just the total.
    expect(summary.byDay[0]!.totals.failuresByCode).toEqual({ RATE_LIMIT: 2, TRANSPORT: 1, UNKNOWN: 1 })
    expect(summary.byModel[0]!.totals.failuresByCode).toEqual({ RATE_LIMIT: 2, TRANSPORT: 1, UNKNOWN: 1 })
  })

  it('merges per-code failure maps key-wise across summaries', () => {
    const at = new Date(2026, 0, 15, 12).getTime()
    const left = summarizeRecords([
      { ...record(at, 'deepseek-chat', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
      { ...record(at + 1, 'deepseek-chat', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
    ])
    const right = summarizeRecords([
      { ...record(at + 2, 'deepseek-chat', undefined, 'failure'), failureCode: 'RATE_LIMIT' },
      { ...record(at + 3, 'deepseek-chat', undefined, 'failure'), failureCode: 'TRANSPORT' },
    ])
    const merged = mergeSummaries(left, right)
    expect(merged.total.failures).toBe(4)
    expect(merged.total.failuresByCode).toEqual({ RATE_LIMIT: 3, TRANSPORT: 1 })
  })

  it('reads a failure-less legacy totals row as zero failures on merge', () => {
    const withFailures = summarizeRecords([
      record(1_700_000_000_000, 'deepseek-chat', undefined, 'failure'),
    ])
    // A legacy rollup side: totals written before the key existed.
    const legacyTotals = { requests: 1, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const legacy: Parameters<typeof mergeSummaries>[0] = {
      total: legacyTotals,
      byDay: [{ day: '2026-01-14', totals: legacyTotals }],
      byHour: [],
      byModel: [{ model: 'deepseek-chat', totals: legacyTotals }],
      rateRows: [],
      recent: [],
    }
    const merged = mergeSummaries(legacy, withFailures)
    expect(merged.total.requests).toBe(1)
    expect(merged.total.failures).toBe(1)
    expect(Number.isNaN(merged.total.inputTokens)).toBe(false)
  })

  it('folds totals over records, counting requests without usage', () => {
    const summary = summarizeRecords([
      record(1_700_000_000_000, 'deepseek-chat', { input: 10, output: 5, cacheRead: 3 }),
      record(1_700_000_000_001, 'deepseek-chat', { input: 20, output: 7, cacheWrite: 2 }),
      record(1_700_000_000_002, 'deepseek-reasoner'),
    ])
    expect(summary.total).toEqual({
      requests: 3,
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      compactions: 0, failures: 0,
    })
  })

  it('folds a compaction record into every dimension and counts it', () => {
    const summary = summarizeRecords([
      record(1_700_000_000_000, 'deepseek-chat', { input: 10, output: 5 }),
      record(1_700_000_000_001, 'deepseek-chat', { input: 280_000, output: 400, cacheRead: 274_000 }, 'compaction'),
      record(1_700_000_000_002, 'deepseek-reasoner', { input: 1, output: 1 }),
    ])
    // requests counts every provider-billed call; compactions singles out the
    // summarize calls (plain requests = 2 here).
    expect(summary.total.requests).toBe(3)
    expect(summary.total.compactions).toBe(1)
    expect(summary.total.inputTokens).toBe(280_011)
    expect(summary.total.outputTokens).toBe(406)
    expect(summary.total.cacheReadTokens).toBe(274_000)
    expect(summary.byModel[0]!.totals.compactions).toBe(1)
    expect(summary.byModel[1]!.totals.compactions).toBe(0)
    expect(summary.rateRows[0]!.totals.compactions).toBe(1)
    // The recent window carries the compaction row verbatim (newest first).
    expect(summary.recent[1]).toMatchObject({ kind: 'compaction', model: 'deepseek-chat' })
  })

  it('bills a compaction record through the same rate chain by its input-side tokens', () => {
    const at = new Date(2026, 0, 15, 10).getTime()
    const summary = summarizeRecords([
      record(at, 'deepseek-chat', { input: 10, output: 5 }),
      record(at, 'deepseek-chat', { input: 540_000, output: 400 }, 'compaction'),
    ], rec => (rec.usage?.inputTokens ?? 0) > 500_000
      ? { ruleStart: 0, ruleEnd: 0, tier: 512_000, slot: -1 }
      : { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 })
    // The compaction's huge input lands in the high tier, the plain one does not.
    expect(summary.rateRows.map(row => row.rate.tier)).toEqual([0, 512_000])
    expect(summary.rateRows[1]!.totals.compactions).toBe(1)
  })

  it('groups by local day ascending and by model descending on requests', () => {
    const first = new Date(2026, 0, 15, 12).getTime()
    const second = new Date(2026, 0, 16, 12).getTime()
    const summary = summarizeRecords([
      record(second, 'deepseek-chat', { input: 1, output: 1 }),
      record(second, 'deepseek-reasoner'),
      record(first, 'deepseek-chat', { input: 1, output: 1 }),
    ])
    expect(summary.byDay.map(row => row.day)).toEqual(['2026-01-15', '2026-01-16'])
    expect(summary.byDay[1]!.totals.requests).toBe(2)
    expect(summary.byModel.map(row => row.model)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(summary.byModel[0]!.totals.requests).toBe(2)
  })

  it('caps the recent window and sorts it descending by time', () => {
    const records = Array.from({ length: RECENT_LIMIT + 5 }, (_, index) =>
      record(1_700_000_000_000 + index, 'deepseek-chat', { input: 1, output: 1 }))
    const summary = summarizeRecords(records)
    expect(summary.recent).toHaveLength(RECENT_LIMIT)
    expect(summary.recent[0]!.time).toBe(records[records.length - 1]!.time)
    const times = summary.recent.map(row => row.time)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('crosses day, model, and rate into rate rows, day then model then rate ascending', () => {
    const first = new Date(2026, 0, 15, 12).getTime()
    const second = new Date(2026, 0, 16, 12).getTime()
    const summary = summarizeRecords([
      record(first, 'deepseek-reasoner', { input: 1, output: 1 }),
      record(first, 'deepseek-chat', { input: 10, output: 5 }),
      record(first, 'deepseek-chat', { input: 1, output: 1 }),
      record(second, 'deepseek-chat', { input: 2, output: 2 }),
    ])
    // Unresolved records fold into the neutral unpriced rate per (day, model).
    const neutral = { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }
    expect(summary.rateRows).toEqual([
      { day: '2026-01-15', model: 'deepseek-chat', rate: neutral, totals: { requests: 2, inputTokens: 11, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { day: '2026-01-15', model: 'deepseek-reasoner', rate: neutral, totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { day: '2026-01-16', model: 'deepseek-chat', rate: neutral, totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
  })

  it('splits one model\'s day across the rates the resolver assigns per record', () => {
    const at = new Date(2026, 0, 15, 10).getTime()
    // Even-index records price at tier 0, odd ones at tier 512000.
    const summary = summarizeRecords([
      record(at, 'deepseek-chat', { input: 10, output: 5 }),
      record(at, 'deepseek-chat', { input: 1, output: 1 }),
    ], rec => (rec.usage?.inputTokens ?? 0) > 5
      ? { ruleStart: 0, ruleEnd: 0, tier: 512_000, slot: -1 }
      : { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 })
    expect(summary.rateRows).toHaveLength(2)
    expect(summary.rateRows.map(row => row.rate.tier)).toEqual([0, 512_000])
    // The token dimensions still fold the model into one row.
    expect(summary.byModel).toHaveLength(1)
    expect(summary.byModel[0]!.totals.requests).toBe(2)
  })

  it('groups by local hour and model, ascending hour then model', () => {
    const morning = new Date(2026, 0, 15, 9, 30).getTime()
    const noon = new Date(2026, 0, 15, 12).getTime()
    const summary = summarizeRecords([
      record(noon, 'deepseek-chat', { input: 2, output: 2 }),
      record(morning, 'deepseek-reasoner', { input: 1, output: 1 }),
      record(morning, 'deepseek-chat', { input: 10, output: 5 }),
    ])
    expect(summary.byHour).toEqual([
      { hour: '2026-01-15T09', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { hour: '2026-01-15T09', model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { hour: '2026-01-15T12', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
    // The same record folds into its day bucket as well.
    expect(summary.byDay[0]!.totals.requests).toBe(3)
  })
})

describe('performance accumulators', () => {
  const at = new Date(2026, 0, 15, 12).getTime()
  /** A streaming sample: 100 output tokens over 1.5s of generation. */
  const stream = { latencyMs: 2000, firstTokenLatencyMs: 500 }

  it('folds timing into the accumulators: streaming samples rank, one-shot rows only count latency', () => {
    const summary = summarizeRecords([
      { ...record(at, 'm1', { input: 10, output: 100 }), ...stream },
      // A second streaming sample: 50 tokens over 0.5s, first token at 1s.
      { ...record(at + 1, 'm1', { input: 10, output: 50 }), latencyMs: 1500, firstTokenLatencyMs: 1000 },
      // Non-streaming: the whole response landed inside the threshold —
      // the latency mean takes it, the speed mean never sees it.
      { ...record(at + 2, 'm1', { input: 10, output: 500 }), latencyMs: 3000, firstTokenLatencyMs: 2900 },
      // No timing at all moves nothing.
      record(at + 3, 'm1', { input: 10, output: 10 }),
      // A failure row never joins a mean.
      record(at + 4, 'm1', undefined, 'failure'),
    ])
    const totals = summary.byModel[0]!.totals
    expect(totals.perfStreamCount).toBe(2)
    expect(totals.perfLatencyMsSum).toBe(2000 + 1500 + 3000)
    expect(totals.perfLatencyCount).toBe(3)
    expect(totals.perfStreamTpsSum).toBeCloseTo(100 / 1.5 + 50 / 0.5, 6)
    expect(totals.perfStreamFirstMsSum).toBe(500 + 1000)
  })

  it('leaves the performance keys unwritten when no record carries timing', () => {
    const summary = summarizeRecords([
      record(at, 'm1', { input: 1, output: 1 }),
      record(at + 1, 'm1', undefined, 'failure'),
    ])
    const totals = summary.byModel[0]!.totals
    expect(totals.perfStreamCount).toBeUndefined()
    expect(totals.perfLatencyMsSum).toBeUndefined()
    expect(totals.perfLatencyCount).toBeUndefined()
  })

  it('merges across summaries and survives the rate-row re-fold of filterSummary', () => {
    const left = summarizeRecords([{ ...record(at, 'm1', { input: 10, output: 100 }), ...stream }])
    const right = summarizeRecords([
      { ...record(at + 86_400_000, 'm1', { input: 10, output: 100 }), ...stream },
      record(at + 86_400_000 + 1, 'm2', { input: 1, output: 1 }),
    ])
    const merged = mergeSummaries(left, right)
    expect(merged.byModel.find(row => row.model === 'm1')!.totals.perfStreamCount).toBe(2)
    // filterSummary rebuilds byModel from the rate rows — the accumulators
    // survive because they ride inside every cell's totals.
    const filtered = filterSummary({ dataDir: '/x', ...merged }, '2026-01-16', '2026-01-16')
    const cell = filtered.byModel.find(row => row.model === 'm1')!.totals
    expect(cell.perfStreamCount).toBe(1)
    expect(cell.perfLatencyMsSum).toBe(2000)
    expect(cell.perfLatencyCount).toBe(1)
    expect(merged.byModel.find(row => row.model === 'm1')!.totals.perfLatencyCount).toBe(2)
  })

  it('derives per-model perf means at the cost layer, over the folded family', () => {
    const summary = summarizeRecords([
      { ...record(at, 'auto/GLM-5.3', { input: 10, output: 100 }), responseModel: 'glm-5.3', ...stream },
      { ...record(at + 1, 'glm-5.3', { input: 10, output: 50 }), latencyMs: 1500, firstTokenLatencyMs: 1000 },
      // One-shot latency joins only the request-latency mean.
      { ...record(at + 2, 'glm-5.3', { input: 10, output: 500 }), latencyMs: 3000, firstTokenLatencyMs: 2900 },
      // No streaming samples → no perf at all.
      record(at + 3, 'cold-model', { input: 1, output: 1 }),
    ])
    // An empty pricing table: perf derives from the timing accumulators,
    // never from prices — the rows all read unpriced and that is fine.
    const costed = attachCosts({ dataDir: '/x', ...summary }, {})
    const glm = costed.byModel.find(row => row.model === 'glm-5.3')!
    expect(glm.perf).toEqual({
      tokensPerSec: (100 / 1.5 + 50 / 0.5) / 2,
      firstTokenMs: (500 + 1000) / 2,
      latencyMs: (2000 + 1500 + 3000) / 3,
      timedRequests: 3,
      samples: 2,
    })
    expect(costed.byModel.find(row => row.model === 'cold-model')!.perf).toBeUndefined()
  })

  it('excludes untimed and invalid-timing requests from every performance mean and count', () => {
    const timed = Array.from({ length: 5 }, (_, i) => ({
      ...record(at + i, 'm1', { input: 10, output: 100 }),
      latencyMs: 10_000, firstTokenLatencyMs: 1000,
    }))
    const untimed = Array.from({ length: 95 }, (_, i) => record(at + 5 + i, 'm1', { input: 10, output: 100 }))
    const summary = summarizeRecords([
      ...timed, ...untimed,
      { ...record(at + 100, 'm1'), latencyMs: -1 },
      { ...record(at + 101, 'm1'), latencyMs: NaN },
      { ...record(at + 102, 'm1', undefined, 'failure'), latencyMs: 10_000 },
    ])
    const model = attachCosts({ dataDir: '/x', ...summary }, {}).byModel[0]!
    expect(model.totals.requests).toBe(102)
    expect(model.perf).toEqual({
      tokensPerSec: 100 / 9, firstTokenMs: 1000, latencyMs: 10_000,
      samples: 5, timedRequests: 5,
    })
  })
})

describe('mergeSummaries', () => {
  it('adds totals and folds per-day and per-model rows by key', () => {
    const dayOne = new Date(2026, 0, 15, 12).getTime()
    const dayTwo = new Date(2026, 0, 16, 12).getTime()
    const left = summarizeRecords([
      record(dayOne, 'deepseek-chat', { input: 10, output: 5 }),
      record(dayOne, 'deepseek-reasoner', { input: 1, output: 1 }),
    ])
    const right = summarizeRecords([
      record(dayOne, 'deepseek-chat', { input: 20, output: 7 }),
      record(dayTwo, 'deepseek-chat', { input: 2, output: 2 }),
    ])
    const merged = mergeSummaries(left, right)
    expect(merged.total).toEqual({
      requests: 4,
      inputTokens: 33,
      outputTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      compactions: 0, failures: 0,
    })
    expect(merged.byDay).toEqual([
      { day: '2026-01-15', totals: { requests: 3, inputTokens: 31, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { day: '2026-01-16', totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
    expect(merged.byModel).toEqual([
      { model: 'deepseek-chat', totals: { requests: 3, inputTokens: 32, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
  })

  it('merges a compaction-carrying side with a legacy side missing the key', () => {
    const at = new Date(2026, 0, 15, 12).getTime()
    const withCompactions = summarizeRecords([
      record(at, 'deepseek-chat', { input: 280_000, output: 400 }, 'compaction'),
    ])
    // A legacy rollup side: totals written before the key existed.
    const legacyTotals = { requests: 1, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const legacy: Parameters<typeof mergeSummaries>[0] = {
      total: legacyTotals,
      byDay: [{ day: '2026-01-14', totals: legacyTotals }],
      byHour: [{ hour: '2026-01-14T12', model: 'deepseek-chat', totals: legacyTotals }],
      byModel: [{ model: 'deepseek-chat', totals: legacyTotals }],
      rateRows: [{ day: '2026-01-14', model: 'deepseek-chat', rate: { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }, totals: legacyTotals }],
      recent: [],
    }
    const merged = mergeSummaries(legacy, withCompactions)
    expect(merged.total.requests).toBe(2)
    expect(merged.total.compactions).toBe(1)
    expect(Number.isNaN(merged.total.inputTokens)).toBe(false)
    expect(merged.total.inputTokens).toBe(280_005)
    expect(merged.byModel[0]!.totals.compactions).toBe(1)
  })

  it('keeps only the newest records across both recent windows', () => {
    const leftTimes = Array.from({ length: RECENT_LIMIT }, (_, index) => 1_700_000_000_000 + index)
    const rightTimes = Array.from({ length: RECENT_LIMIT }, (_, index) => 1_700_000_000_100 + index)
    const left = summarizeRecords(leftTimes.map(time => record(time, 'deepseek-chat')))
    const right = summarizeRecords(rightTimes.map(time => record(time, 'deepseek-chat')))
    const merged = mergeSummaries(left, right)
    expect(merged.recent).toHaveLength(RECENT_LIMIT)
    expect(merged.recent.map(row => row.time)).toEqual(
      [...rightTimes].sort((a, b) => b - a))
  })

  it('matches summarizing the concatenated records', () => {
    const records = [
      record(new Date(2026, 0, 14, 23, 59, 59, 999).getTime(), 'deepseek-chat', { input: 3, output: 1, cacheRead: 4 }),
      record(new Date(2026, 0, 15, 0, 0, 0, 1).getTime(), 'deepseek-reasoner', { input: 5, output: 2 }),
      record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat', { input: 7, output: 3, cacheWrite: 6 }),
      record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat'),
    ]
    const left = summarizeRecords(records.slice(0, 2))
    const right = summarizeRecords(records.slice(2))
    expect(mergeSummaries(left, right)).toEqual(summarizeRecords(records))
  })
})

describe('filterSummary', () => {
  /** Three days (01-14..01-16) × two models, recent spanning all three days. */
  function fixture(): ReturnType<typeof summarizeRecords> & { dataDir: string } {
    const rows: UsageRecord[] = [
      record(new Date(2026, 0, 14, 10).getTime(), 'deepseek-chat', { input: 1, output: 1 }),
      record(new Date(2026, 0, 14, 11).getTime(), 'deepseek-reasoner', { input: 2, output: 2 }),
      record(new Date(2026, 0, 15, 10).getTime(), 'deepseek-chat', { input: 10, output: 10 }),
      record(new Date(2026, 0, 15, 23, 59, 59, 999).getTime(), 'deepseek-chat', { input: 20, output: 20 }),
      record(new Date(2026, 0, 16, 10).getTime(), 'deepseek-reasoner', { input: 100, output: 100 }),
    ]
    return { dataDir: 'C:/data', ...summarizeRecords(rows) }
  }

  it('returns the summary unchanged without filters', () => {
    const summary = fixture()
    expect(filterSummary(summary)).toEqual(summary)
  })

  it('keeps only the requested inclusive day range', () => {
    const filtered = filterSummary(fixture(), '2026-01-15', '2026-01-15')
    expect(filtered.total).toEqual({
      requests: 2, inputTokens: 30, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0,
    })
    expect(filtered.byDay.map(row => row.day)).toEqual(['2026-01-15'])
    // Per-model rows re-aggregate from the crossed rows, not copied whole.
    expect(filtered.byModel).toEqual([
      { model: 'deepseek-chat', totals: { requests: 2, inputTokens: 30, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
  })

  it('keeps only the requested model', () => {
    const filtered = filterSummary(fixture(), undefined, undefined, 'deepseek-reasoner')
    expect(filtered.total.requests).toBe(2)
    expect(filtered.byDay.map(row => row.day)).toEqual(['2026-01-14', '2026-01-16'])
    expect(filtered.byModel.map(row => row.model)).toEqual(['deepseek-reasoner'])
  })

  it('combines the day range with the model', () => {
    const filtered = filterSummary(fixture(), '2026-01-14', '2026-01-15', 'deepseek-reasoner')
    expect(filtered.total.inputTokens).toBe(2)
    expect(filtered.byDay.map(row => row.day)).toEqual(['2026-01-14'])
  })

  it('filters the recent window by the day range and model', () => {
    const filtered = filterSummary(fixture(), '2026-01-15', '2026-01-16', 'deepseek-chat')
    expect(filtered.recent).toHaveLength(2)
    for (const row of filtered.recent) {
      expect(row.model).toBe('deepseek-chat')
      expect(row.time).toBeGreaterThanOrEqual(new Date(2026, 0, 15).getTime())
      expect(row.time).toBeLessThanOrEqual(new Date(2026, 0, 16, 23, 59, 59, 999).getTime())
    }
  })

  it('filters the hour rows by the day range and model', () => {
    const filtered = filterSummary(fixture(), '2026-01-15', '2026-01-15', 'deepseek-chat')
    expect(filtered.byHour).toEqual([
      { hour: '2026-01-15T10', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
      { hour: '2026-01-15T23', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
    // A model filter drops the other model's hours entirely.
    const reasoner = filterSummary(fixture(), '2026-01-14', '2026-01-16', 'deepseek-reasoner')
    expect(reasoner.byHour.map(row => row.hour)).toEqual(['2026-01-14T11', '2026-01-16T10'])
  })

  it('matches priced aliases of the selected model when a canonical map is given', () => {
    const at = (hour: number): number => new Date(2026, 0, 15, hour).getTime()
    const summary = {
      dataDir: 'C:/data',
      ...summarizeRecords([
        record(at(10), 'deepseek-v4-flash', { input: 10, output: 1 }),
        record(at(11), 'deepseek-v4-flash-0731', { input: 20, output: 2 }),
        record(at(12), 'glm-5.3', { input: 5, output: 1 }),
      ]),
    }
    const canonical = new Map([
      ['deepseek-v4-flash', 'deepseek-v4-flash'],
      ['deepseek-v4-flash-0731', 'deepseek-v4-flash'],
    ])
    const byId = filterSummary(summary, undefined, undefined, 'deepseek-v4-flash', canonical)
    expect(byId.total.requests).toBe(2)
    expect(byId.total.inputTokens).toBe(30)
    expect(byId.byModel.map(row => row.model).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-0731'])
    expect(byId.recent).toHaveLength(2)
    // Selecting an alias query also covers the whole family.
    const byAlias = filterSummary(summary, undefined, undefined, 'deepseek-v4-flash-0731', canonical)
    expect(byAlias.total.requests).toBe(2)
    // An unpriced name still matches only itself.
    const unpriced = filterSummary(summary, undefined, undefined, 'glm-5.3', canonical)
    expect(unpriced.total.requests).toBe(1)
    expect(unpriced.byModel.map(row => row.model)).toEqual(['glm-5.3'])
  })
})

describe('filterRecordsBySessions', () => {
  /** Three records: two sessions share a day; one has no usage at all. */
  function fixture(): UsageRecord[] {
    return [
      { ...record(100, 'deepseek-chat', { input: 1 }), sessionId: 'alpha' },
      { ...record(200, 'deepseek-reasoner', { input: 2 }), sessionId: 'alpha' },
      { ...record(300, 'deepseek-chat', { input: 3 }), sessionId: 'child' },
      { ...record(400, 'deepseek-chat'), sessionId: 'child' },
    ]
  }

  it('keeps only the listed sessions, preserving input order', () => {
    const kept = filterRecordsBySessions(fixture(), ['alpha'])
    expect(kept.map(row => row.sessionId)).toEqual(['alpha', 'alpha'])
    expect(kept.every(row => row.requestId !== 'req-300-deepseek-chat')).toBe(true)
  })

  it('aggregates a parent with its children from one id list', () => {
    const kept = filterRecordsBySessions(fixture(), ['alpha', 'child'])
    expect(kept).toHaveLength(4)
  })

  it('returns no records for an unknown session or an empty list', () => {
    expect(filterRecordsBySessions(fixture(), ['nobody'])).toEqual([])
    expect(filterRecordsBySessions(fixture(), [])).toEqual([])
  })
})

describe('requestSeriesOf', () => {
  /** Three records on two days, one without usage. */
  function fixture(): UsageRecord[] {
    return [
      { ...record(new Date(2026, 0, 14, 10).getTime(), 'deepseek-chat', { input: 10, output: 5, cacheRead: 3 }), sessionId: 's1' },
      { ...record(new Date(2026, 0, 15, 11).getTime(), 'deepseek-reasoner', { input: 2, output: 2, cacheWrite: 1 }), sessionId: 's1' },
      { ...record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat'), sessionId: 's1' },
    ]
  }

  it('emits one point per request in time order with the summed buckets', () => {
    const series = requestSeriesOf(fixture())
    expect(series).toEqual([
      { time: new Date(2026, 0, 14, 10).getTime(), tokens: 18 },
      { time: new Date(2026, 0, 15, 11).getTime(), tokens: 5 },
      // A request without usage counts a point with zero tokens.
      { time: new Date(2026, 0, 15, 12).getTime(), tokens: 0 },
    ])
  })

  it('honours the day range and model filters', () => {
    const series = requestSeriesOf(fixture(), '2026-01-15', '2026-01-15', 'deepseek-reasoner')
    expect(series).toEqual([{ time: new Date(2026, 0, 15, 11).getTime(), tokens: 5 }])
    expect(requestSeriesOf(fixture(), '2026-01-16')).toEqual([])
  })

  it('excludes failure rows — a failed request plots no token point', () => {
    const withFailure = [
      ...fixture(),
      record(new Date(2026, 0, 15, 13).getTime(), 'deepseek-chat', undefined, 'failure'),
    ]
    const series = requestSeriesOf(withFailure)
    expect(series).toHaveLength(3)
    expect(series.some(point => point.time === new Date(2026, 0, 15, 13).getTime())).toBe(false)
  })
})

describe('buildSummary rollup (cold/hot split)', () => {
  /** Fixed clock: today is 2026-01-16 local. */
  const today = (): Date => new Date(2026, 0, 16, 12)

  async function writeDayFile(dir: string, name: string, records: readonly UsageRecord[]): Promise<void> {
    await writeFile(join(dir, name), records.map(row => JSON.stringify(row)).join('\n') + '\n')
  }

  it('absorbs frozen files into a rollup and matches a full read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat')])
    await writeDayFile(dir, 'usage-2026-01-15.jsonl', [record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat')])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat')])
    const summary = await buildSummary(dir, today)
    expect(summary).toEqual({ dataDir: dir, ...summarizeRecords(await readAllRecords(dir)) })
    const stored = await readRollup(dir)
    expect(stored?.upto).toBe('2026-01-15')
    expect(stored?.total.requests).toBe(2)
  })

  it('does not reread absorbed files on the next call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat')])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat')])
    const first = await buildSummary(dir, today)
    // Corrupt an absorbed file: the next read must still come from the rollup.
    await writeFile(join(dir, 'usage-2026-01-14.jsonl'), 'garbage that would parse to nothing')
    await expect(buildSummary(dir, today)).resolves.toEqual(first)
  })

  it('advances the rollup over newly frozen files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat')])
    await buildSummary(dir, today)
    await writeDayFile(dir, 'usage-2026-01-15.jsonl', [record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat')])
    const summary = await buildSummary(dir, today)
    expect(summary.total.requests).toBe(2)
    await expect(readRollup(dir)).resolves.toMatchObject({ upto: '2026-01-15', total: { requests: 2 } })
  })

  it.each([undefined, 2])('rebuilds aggregate format %s so valid timing counts backfill over history', async (aggregateFormat) => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    const frozenAt = new Date(2026, 0, 15, 12).getTime()
    await writeDayFile(dir, 'usage-2026-01-15.jsonl', [
      { ...record(frozenAt, 'deepseek-chat', { input: 10, output: 100 }), latencyMs: 2000, firstTokenLatencyMs: 500 },
    ])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat')])
    // A rollup written before the performance feature existed: shape 1 —
    // no aggregateFormat key, no timing accumulators, valid otherwise.
    await writeFile(join(dir, 'rollup.json'), JSON.stringify({
      upto: '2026-01-15',
      ...summarizeRecords([record(frozenAt, 'deepseek-chat', { input: 10, output: 100 })]),
      ...(aggregateFormat === undefined ? {} : { aggregateFormat }),
    }))
    await buildSummary(dir, today)
    const stored = await readRollup(dir)
    // The rebuild rewrites the rollup under the new format with the timing
    // the day files carried all along.
    expect(stored?.aggregateFormat).toBe(ROLLUP_AGGREGATE_FORMAT)
    expect(stored?.total.perfStreamCount).toBe(1)
    expect(stored?.total.perfLatencyCount).toBe(1)
  })

  it('keeps a current-format rollup: absorbed files stay unread, timing intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-15.jsonl', [
      { ...record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat', { input: 10, output: 100 }), latencyMs: 2000, firstTokenLatencyMs: 500 },
    ])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat')])
    await buildSummary(dir, today)
    // Corrupt an absorbed frozen file: a current-format rollup must serve
    // from the rollup alone and keep its backfilled timing.
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), 'garbage that would parse to nothing')
    const summary = await buildSummary(dir, today)
    expect(summary.total.perfStreamCount).toBe(1)
  })

  it('folds a yesterday-keyed record from today’s file into yesterday’s bucket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-15.jsonl', [record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat', { input: 1, output: 1 })])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 15, 23, 59, 59, 999).getTime(), 'deepseek-chat', { input: 1, output: 1 })])
    const summary = await buildSummary(dir, today)
    expect(summary.byDay).toEqual([
      { day: '2026-01-15', totals: { requests: 2, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0, failures: 0 } },
    ])
  })

  it('rebuilds a corrupt rollup from the day files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat')])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat')])
    await writeFile(join(dir, 'rollup.json'), 'not json')
    const summary = await buildSummary(dir, today)
    expect(summary.total.requests).toBe(2)
    await expect(readRollup(dir)).resolves.toMatchObject({ upto: '2026-01-14' })
  })

  it('writes no rollup while only today’s file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 16, 12).getTime(), 'deepseek-chat')])
    const summary = await buildSummary(dir, today)
    expect(summary.total.requests).toBe(1)
    await expect(readRollup(dir)).resolves.toBeNull()
  })

  it('does not recount absorbed files when the clock steps back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    const absorbed = record(new Date(2026, 0, 17, 12).getTime(), 'deepseek-chat')
    await writeDayFile(dir, 'usage-2026-01-17.jsonl', [absorbed])
    await writeRollup(dir, { upto: '2026-01-18', ...summarizeRecords([absorbed]) })
    const summary = await buildSummary(dir, today)
    expect(summary.total.requests).toBe(1)
  })

  it('skips rows appended to an already-absorbed frozen file until the rollup is dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat', { input: 1, output: 1 })])
    // Absorb the frozen file: the rollup now covers 2026-01-14.
    await buildSummary(dir, today)
    // A sync backfills another row into that same frozen file — the
    // cross-midnight shape: the sync's clock still names an absorbed day.
    await writeDayFile(dir, 'usage-2026-01-14.jsonl', [
      record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat', { input: 1, output: 1 }),
      record(new Date(2026, 0, 14, 13).getTime(), 'deepseek-chat', { input: 280_000, output: 400 }, 'compaction'),
    ])
    // The absorbed file is not re-read, so the appended row is invisible…
    const stale = await buildSummary(dir, today)
    expect(stale.total.requests).toBe(1)
    // …until the derived rollup is dropped — what the post-sync invalidation
    // does. The rebuild reads every day file again and the backfilled
    // compaction lands in the totals.
    await unlink(join(dir, 'rollup.json'))
    clearRecordCache(dir)
    const rebuilt = await buildSummary(dir, today)
    expect(rebuilt.total.requests).toBe(2)
    expect(rebuilt.total.compactions).toBe(1)
    expect(rebuilt.total.inputTokens).toBe(280_001)
  })
})

describe('readAllRecords / buildSummary', () => {
  it('reads day files in order, skipping malformed lines and foreign files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-stats-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), [
      JSON.stringify(record(1, 'deepseek-chat', { input: 1, output: 1 })),
      'not json',
      '',
    ].join('\n'))
    await writeFile(join(dir, 'usage-2026-01-16.jsonl'), JSON.stringify(record(2, 'deepseek-chat')))
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    const records = await readAllRecords(dir)
    expect(records.map(row => row.requestId)).toEqual(['req-1-deepseek-chat', 'req-2-deepseek-chat'])
    const summary = await buildSummary(dir)
    expect(summary.dataDir).toBe(dir)
    expect(summary.total.requests).toBe(2)
    expect(summary.total.inputTokens).toBe(1)
  })

  it('returns an empty summary for an absent data directory', async () => {
    const dir = join(tmpdir(), `token-usage-absent-${Date.now()}`)
    const records = await readAllRecords(dir)
    expect(records).toEqual([])
    const summary = await buildSummary(dir)
    expect(summary.total.requests).toBe(0)
    expect(summary.byDay).toEqual([])
    expect(summary.byHour).toEqual([])
    expect(summary.byModel).toEqual([])
    expect(summary.recent).toEqual([])
  })
})

describe('attachCosts', () => {
  const pricing: PricingTable = {
    'deepseek-chat': {
      base: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
      contextTiers: [],
      dailySlots: [],
      timeRules: [],
    },
  }

  function tokenSummary(): ReturnType<typeof summarizeRecords> & { dataDir: string } {
    return {
      dataDir: 'C:/data',
      ...summarizeRecords([
        record(1, 'deepseek-chat', { input: 1_000_000, output: 500_000, cacheRead: 250_000 }),
        record(2, 'deepseek-reasoner', { input: 1_000_000, output: 1_000_000 }),
      ]),
    }
  }

  it('bills per-model costs, the total, and the pricing table', () => {
    const summary = attachCosts(tokenSummary(), pricing)
    expect(summary.byModel).toEqual([
      {
        model: 'deepseek-chat',
        totals: expect.objectContaining({ requests: 1 }),
        cost: 2 + 4 + 0.125,
      },
      {
        model: 'deepseek-reasoner',
        totals: expect.objectContaining({ requests: 1 }),
        cost: 0,
      },
    ])
    expect(summary.totalCost).toBe(2 + 4 + 0.125)
    expect(summary.unpricedModels).toEqual(['deepseek-reasoner'])
    expect(summary.pricing).toEqual(pricing)
  })

  it('prices each rate row through its identity and re-prices after an update', () => {
    // One record at the rule rate, one at the base rate: same model, same day.
    const at = new Date(2026, 0, 15, 10).getTime()
    const resolve: RateResolver = rec => rec.requestId.endsWith('r1')
      ? { ruleStart: 0, ruleEnd: 4_102_415_999, tier: 0, slot: -1 }
      : { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }
    const r1 = { ...record(at, 'deepseek-chat', { input: 1_000_000, output: 0 }), requestId: 'r1' }
    const r2 = { ...record(at, 'deepseek-chat', { input: 1_000_000, output: 0 }), requestId: 'r2' }
    const base = {
      dataDir: 'C:/data',
      ...summarizeRecords([r1, r2], resolve),
    }
    const discounted: PricingTable = {
      'deepseek-chat': {
        base: { inputPerMillion: 2, outputPerMillion: 8 },
        contextTiers: [],
        dailySlots: [],
        timeRules: [{ startTime: 0, endTime: 4_102_415_999, rates: { inputPerMillion: 1, outputPerMillion: 4 } }],
      },
    }
    // Row r1 billed at the rule rate (¥1), row r2 at the base rate (¥2).
    const summary = attachCosts(base, discounted)
    expect(summary.byModel[0]!.cost).toBe(1 + 2)
    expect(summary.totalCost).toBe(3)
    // A price update re-prices the same identities with no re-aggregation.
    const repriced = attachCosts(base, {
      'deepseek-chat': {
        ...discounted['deepseek-chat']!,
        timeRules: [{ startTime: 0, endTime: 4_102_415_999, rates: { inputPerMillion: 0.5, outputPerMillion: 2 } }],
      },
    })
    expect(repriced.totalCost).toBe(0.5 + 2)
  })

  it('leaves the token aggregation untouched', () => {
    const before = tokenSummary()
    const summary = attachCosts(before, pricing)
    expect(summary.total).toEqual(before.total)
    expect(summary.byDay).toEqual(before.byDay)
    expect(summary.byHour).toEqual(before.byHour)
    expect(summary.rateRows).toEqual(before.rateRows)
    expect(summary.recent).toEqual(before.recent)
    expect(summary.dataDir).toBe(before.dataDir)
  })

  it('folds alias usage onto the priced model-id', () => {
    const rates = {
      base: { inputPerMillion: 1, outputPerMillion: 2 },
      contextTiers: [],
      dailySlots: [],
      timeRules: [],
    }
    const table: PricingTable = {
      'deepseek-v4-flash': rates,
      'deepseek-v4-flash-0731': rates,
    }
    const canonical = new Map([
      ['deepseek-v4-flash', 'deepseek-v4-flash'],
      ['deepseek-v4-flash-0731', 'deepseek-v4-flash'],
    ])
    const summary = attachCosts({
      dataDir: 'C:/data',
      ...summarizeRecords([
        record(1, 'deepseek-v4-flash', { input: 1_000_000, output: 0 }),
        record(2, 'deepseek-v4-flash-0731', { input: 1_000_000, output: 0 }),
      ]),
    }, table, canonical)
    expect(summary.byModel).toEqual([
      {
        model: 'deepseek-v4-flash',
        totals: expect.objectContaining({ requests: 2, inputTokens: 2_000_000 }),
        cost: 2,
      },
    ])
    expect(summary.totalCost).toBe(2)
    expect(summary.unpricedModels).toEqual([])
    // rateRows stay keyed by the raw name so a later feed can regroup.
    expect(summary.rateRows.map(row => row.model).sort()).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-0731',
    ])
  })

  it('bills through the reported response model without any alias pattern', () => {
    // The feed only names the canonical id; the routed alias resolves only
    // because the record carries the provider-reported response model.
    const table: PricingTable = {
      'glm-5.3-flash': {
        base: { inputPerMillion: 1, outputPerMillion: 2 },
        contextTiers: [],
        dailySlots: [],
        timeRules: [],
      },
    }
    const summary = attachCosts({
      dataDir: 'C:/data',
      ...summarizeRecords([
        { ...record(1, 'zcode/GLM-5.3-Flash-Trial', { input: 1_000_000 }), responseModel: 'glm-5.3-flash' },
      ]),
    }, table)
    expect(summary.byModel).toEqual([
      { model: 'glm-5.3-flash', totals: expect.objectContaining({ requests: 1 }), cost: 1 },
    ])
    expect(summary.totalCost).toBe(1)
    expect(summary.unpricedModels).toEqual([])
  })

  it('leaves unpriced names unmerged', () => {
    const summary = attachCosts({
      dataDir: 'C:/data',
      ...summarizeRecords([
        record(1, 'foo-model', { input: 1 }),
        record(2, 'bar-model', { input: 1 }),
      ]),
    }, {}, new Map())
    expect(summary.byModel.map(row => row.model)).toEqual(['bar-model', 'foo-model'])
    expect(summary.unpricedModels).toEqual(['bar-model', 'foo-model'])
  })
})

describe('readCachedRecords', () => {
  afterEach(() => { clearRecordCache() })

  /** Fixed clock: today is 2026-01-16 local, so the 14th/15th files are frozen. */
  const today = (): Date => new Date(2026, 0, 16, 12)

  async function writeDay(dir: string, name: string, records: readonly UsageRecord[]): Promise<void> {
    await writeFile(join(dir, name), records.map(row => JSON.stringify(row)).join('\n') + '\n')
  }

  it('does not reread a frozen day file on the next call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-cache-cold-'))
    await writeDay(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat', { input: 1, output: 1 })])
    const first = await readCachedRecords(dir, today)
    expect(first).toHaveLength(1)
    expect(first[0]!.usage?.inputTokens).toBe(1)
    // Corrupt the frozen file: the next read must still come from memory.
    await writeFile(join(dir, 'usage-2026-01-14.jsonl'), 'garbage that would parse to nothing')
    const second = await readCachedRecords(dir, today)
    expect(second).toEqual(first)
  })

  it('re-reads today\'s file after it grows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-cache-hot-'))
    const noon = new Date(2026, 0, 16, 12).getTime()
    await writeDay(dir, 'usage-2026-01-16.jsonl', [record(noon, 'deepseek-chat', { input: 1, output: 1 })])
    expect(await readCachedRecords(dir, today)).toHaveLength(1)
    await writeDay(dir, 'usage-2026-01-16.jsonl', [
      record(noon, 'deepseek-chat', { input: 1, output: 1 }),
      record(noon + 1, 'deepseek-chat', { input: 2, output: 2 }),
    ])
    const second = await readCachedRecords(dir, today)
    expect(second).toHaveLength(2)
    expect(second[1]!.usage?.inputTokens).toBe(2)
  })

  it('shares one in-flight load across concurrent readers of the same directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-cache-fly-'))
    await writeDay(dir, 'usage-2026-01-14.jsonl', [record(new Date(2026, 0, 14, 12).getTime(), 'deepseek-chat')])
    const [left, right] = await Promise.all([readCachedRecords(dir, today), readCachedRecords(dir, today)])
    expect(left).toEqual(right)
    expect(left).toHaveLength(1)
  })
})
