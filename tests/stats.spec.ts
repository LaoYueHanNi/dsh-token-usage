import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRollup, writeRollup } from '../src/rollup.ts'
import { RECENT_LIMIT, buildSummary, mergeSummaries, readAllRecords, summarizeRecords } from '../src/stats.ts'
import type { UsageRecord } from '../src/usage-record.ts'

/** One record with the given time and usage buckets (usage optional). */
function record(time: number, model: string, usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): UsageRecord {
  return {
    requestId: `req-${time}-${model}`,
    time,
    sessionId: 's1',
    model,
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
    })
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
    })
    expect(merged.byDay).toEqual([
      { day: '2026-01-15', totals: { requests: 3, inputTokens: 31, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { day: '2026-01-16', totals: { requests: 1, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ])
    expect(merged.byModel).toEqual([
      { model: 'deepseek-chat', totals: { requests: 3, inputTokens: 32, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ])
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
      { day: '2026-01-15', totals: { requests: 2, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
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
    expect(summary.byModel).toEqual([])
    expect(summary.recent).toEqual([])
  })
})
