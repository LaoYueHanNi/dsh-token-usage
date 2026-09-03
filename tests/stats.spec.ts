import { mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRollup, writeRollup } from '../src/rollup.ts'
import { clearRecordCache, readCachedRecords } from '../src/record-cache.ts'
import { RECENT_LIMIT, attachCosts, buildSummary, filterRecordsBySessions, filterSummary, mergeSummaries, readAllRecords, requestSeriesOf, summarizeRecords } from '../src/stats.ts'
import type { RateResolver } from '../src/stats.ts'
import type { PricingTable } from '../src/wire.ts'
import type { UsageRecord } from '../src/usage-record.ts'

/** One record with the given time and usage buckets (usage optional); pass
 * `kind: 'compaction'` for a compaction summarize row. */
function record(time: number, model: string, usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, kind?: 'compaction'): UsageRecord {
  return {
    requestId: kind === 'compaction' ? `compaction-${time}` : `req-${time}-${model}`,
    time,
    sessionId: 's1',
    model,
    ...(kind === 'compaction' ? { kind } : {}),
    ...usage === undefined ? {} : {
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
      compactions: 0,
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
      { day: '2026-01-15', model: 'deepseek-chat', rate: neutral, totals: { requests: 2, inputTokens: 11, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { day: '2026-01-15', model: 'deepseek-reasoner', rate: neutral, totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { day: '2026-01-16', model: 'deepseek-chat', rate: neutral, totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
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
      { hour: '2026-01-15T09', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { hour: '2026-01-15T09', model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { hour: '2026-01-15T12', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
    ])
    // The same record folds into its day bucket as well.
    expect(summary.byDay[0]!.totals.requests).toBe(3)
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
      compactions: 0,
    })
    expect(merged.byDay).toEqual([
      { day: '2026-01-15', totals: { requests: 3, inputTokens: 31, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { day: '2026-01-16', totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
    ])
    expect(merged.byModel).toEqual([
      { model: 'deepseek-chat', totals: { requests: 3, inputTokens: 32, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
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
      requests: 2, inputTokens: 30, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0,
    })
    expect(filtered.byDay.map(row => row.day)).toEqual(['2026-01-15'])
    // Per-model rows re-aggregate from the crossed rows, not copied whole.
    expect(filtered.byModel).toEqual([
      { model: 'deepseek-chat', totals: { requests: 2, inputTokens: 30, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
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
      { hour: '2026-01-15T10', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
      { hour: '2026-01-15T23', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
    ])
    // A model filter drops the other model's hours entirely.
    const reasoner = filterSummary(fixture(), '2026-01-14', '2026-01-16', 'deepseek-reasoner')
    expect(reasoner.byHour.map(row => row.hour)).toEqual(['2026-01-14T11', '2026-01-16T10'])
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

  it('folds a yesterday-keyed record from today’s file into yesterday’s bucket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-split-'))
    await writeDayFile(dir, 'usage-2026-01-15.jsonl', [record(new Date(2026, 0, 15, 12).getTime(), 'deepseek-chat', { input: 1, output: 1 })])
    await writeDayFile(dir, 'usage-2026-01-16.jsonl', [record(new Date(2026, 0, 15, 23, 59, 59, 999).getTime(), 'deepseek-chat', { input: 1, output: 1 })])
    const summary = await buildSummary(dir, today)
    expect(summary.byDay).toEqual([
      { day: '2026-01-15', totals: { requests: 2, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, compactions: 0 } },
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
