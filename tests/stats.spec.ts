import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT, buildSummary, readAllRecords, summarizeRecords } from '../src/stats.ts'
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
