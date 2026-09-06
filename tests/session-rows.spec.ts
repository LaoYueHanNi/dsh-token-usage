import { describe, expect, it } from 'vitest'
import { attachCosts, buildSessionRows, filterSummary, mergeSummaries, summarizeRecords } from '../src/stats.ts'
import type { SessionMetaEntry } from '../src/stats.ts'
import type { CostedSummary } from '../src/wire.ts'
import type { UsageRecord } from '../src/usage-record.ts'

/** One record with the given time, session, and usage buckets. */
function record(time: number, sessionId: string, model: string, usage?: { input?: number; output?: number }): UsageRecord {
  return {
    requestId: `req-${time}-${sessionId}-${model}`,
    time,
    sessionId,
    model,
    ...(usage === undefined ? {} : {
      usage: {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
      },
    }),
  }
}

const DAY = (year: number, month: number, date: number, hour = 12): number =>
  new Date(year, month - 1, date, hour).getTime()

describe('summarizeRecords bySession', () => {
  it('folds one cell per (session, day, model, rate) with the max lastTime', () => {
    const summary = summarizeRecords([
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat', { input: 10, output: 5 }),
      record(DAY(2026, 1, 15, 14), 's1', 'deepseek-chat', { input: 20, output: 6 }),
    ])
    expect(summary.bySession).toHaveLength(1)
    const cell = summary.bySession[0]!
    expect(cell).toMatchObject({
      sessionId: 's1',
      day: '2026-01-15',
      model: 'deepseek-chat',
      lastTime: DAY(2026, 1, 15, 14),
    })
    expect(cell.totals.requests).toBe(2)
    expect(cell.totals.inputTokens).toBe(30)
  })

  it('splits cells across sessions, days, and models', () => {
    const summary = summarizeRecords([
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat'),
      record(DAY(2026, 1, 15, 9), 's2', 'deepseek-chat'),
      record(DAY(2026, 1, 16, 9), 's1', 'deepseek-chat'),
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-reasoner'),
    ])
    const keys = summary.bySession.map(row => `${row.sessionId}/${row.day}/${row.model}`)
    expect(keys).toEqual([
      's1/2026-01-15/deepseek-chat',
      's1/2026-01-15/deepseek-reasoner',
      's1/2026-01-16/deepseek-chat',
      's2/2026-01-15/deepseek-chat',
    ])
  })

  it('gives an unattributed failure (model "") its own session cell', () => {
    const summary = summarizeRecords([
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat'),
      { ...record(DAY(2026, 1, 15, 10), 's1', '', undefined), kind: 'failure', failureCode: 'RATE_LIMIT' },
    ])
    // Same granule as rateRows: the failure keeps its own (session, day,
    // model='', rate) cell — not merged into the priced cell — so request
    // counts reconcile per session exactly like the day dimension.
    expect(summary.bySession).toHaveLength(2)
    const failureCell = summary.bySession.find(cell => cell.model === '')!
    expect(failureCell.totals.requests).toBe(0)
    expect(failureCell.totals.failures).toBe(1)
    const pricedCell = summary.bySession.find(cell => cell.model !== '')!
    expect(pricedCell.totals.requests).toBe(1)
  })

  it('reconciles: session-cell totals sum to the grand total', () => {
    const records = [
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat', { input: 10, output: 5 }),
      record(DAY(2026, 1, 16, 9), 's1', 'deepseek-reasoner', { input: 7, output: 2 }),
      record(DAY(2026, 1, 15, 9), 's2', 'deepseek-chat', { input: 3, output: 1 }),
      { ...record(DAY(2026, 1, 15, 10), 's2', '', undefined), kind: 'failure' },
    ]
    const summary = summarizeRecords(records)
    let requests = 0
    let failures = 0
    let input = 0
    for (const cell of summary.bySession) {
      requests += cell.totals.requests
      failures += cell.totals.failures ?? 0
      input += cell.totals.inputTokens
    }
    expect(requests).toBe(summary.total.requests)
    expect(failures).toBe(summary.total.failures)
    expect(input).toBe(summary.total.inputTokens)
  })
})

describe('mergeSummaries bySession', () => {
  it('folds cells by (session, day, model, rate) and keeps the max lastTime', () => {
    const left = summarizeRecords([record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat', { input: 10 })])
    const right = summarizeRecords([record(DAY(2026, 1, 15, 15), 's1', 'deepseek-chat', { input: 5 })])
    const merged = mergeSummaries(left, right)
    expect(merged.bySession).toHaveLength(1)
    const cell = merged.bySession[0]!
    expect(cell.totals.requests).toBe(2)
    expect(cell.totals.inputTokens).toBe(15)
    expect(cell.lastTime).toBe(DAY(2026, 1, 15, 15))
  })

  it('keeps distinct sessions and days apart through the merge', () => {
    const left = summarizeRecords([record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat')])
    const right = summarizeRecords([
      record(DAY(2026, 1, 15, 9), 's2', 'deepseek-chat'),
      record(DAY(2026, 1, 16, 9), 's1', 'deepseek-chat'),
    ])
    const merged = mergeSummaries(left, right)
    expect(merged.bySession).toHaveLength(3)
  })
})

describe('filterSummary bySession', () => {
  it("keeps only the window's and model's share of each session", () => {
    const summary = summarizeRecords([
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat', { input: 10 }),
      record(DAY(2026, 1, 20, 9), 's1', 'deepseek-chat', { input: 40 }),
      record(DAY(2026, 1, 15, 9), 's2', 'deepseek-reasoner', { input: 3 }),
    ])
    const filtered = filterSummary({ dataDir: '/x', ...summary }, '2026-01-15', '2026-01-15')
    // Session s1 keeps only its in-window day cell; s2 (also in-window)
    // stays whole. The out-of-window cell drops.
    expect(filtered.bySession.map(row => `${row.sessionId}/${row.day}`)).toEqual([
      's1/2026-01-15',
      's2/2026-01-15',
    ])
    expect(filtered.bySession[0]!.totals.inputTokens).toBe(10)
    const byModelFilter = filterSummary({ dataDir: '/x', ...summary }, undefined, undefined, 'deepseek-reasoner')
    // Model filter: only the sessions whose in-filter cells exist remain —
    // "which sessions consumed this model" is the crossed reading.
    expect(byModelFilter.bySession.map(row => row.sessionId)).toEqual(['s2'])
  })
})

describe('attachCosts bySession', () => {
  it('bills each session cell from its own rate identity', () => {
    const records = [
      record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat', { input: 1_000_000, output: 0 }),
      record(DAY(2026, 1, 15, 9), 's2', 'deepseek-chat', { input: 1_000_000, output: 0 }),
      record(DAY(2026, 1, 15, 9), 's3', 'mystery-model', { input: 1_000_000 }),
    ]
    const pricing: Parameters<typeof attachCosts>[1] = {
      'deepseek-chat': {
        base: { inputPerMillion: 2, outputPerMillion: 8 },
        contextTiers: [], dailySlots: [], timeRules: [],
      },
    }
    const costed = attachCosts({ dataDir: '/x', ...summarizeRecords(records) }, pricing)
    const cells = new Map(costed.bySession.map(cell => [cell.sessionId, cell]))
    expect(cells.get('s1')!.cost).toBeCloseTo(2)
    expect(cells.get('s2')!.cost).toBeCloseTo(2)
    expect(cells.get('s3')!.cost).toBe(0)
    // The session costs fold exactly into the per-model cost and the total.
    expect(costed.byModel.find(row => row.model === 'deepseek-chat')!.cost).toBeCloseTo(4)
    expect(costed.totalCost).toBeCloseTo(4)
  })
})

describe('buildSessionRows', () => {
  const records = [
    // Root s1: two days, two models.
    record(DAY(2026, 1, 15, 9), 's1', 'deepseek-chat', { input: 1_000_000 }),
    record(DAY(2026, 1, 16, 9), 's1', 'deepseek-reasoner', { input: 2_000_000 }),
    // Child c1 of s1; grandchild g1 of c1 (nested folds to the topmost root).
    record(DAY(2026, 1, 15, 10), 'c1', 'deepseek-chat', { input: 3_000_000 }),
    record(DAY(2026, 1, 15, 11), 'g1', 'deepseek-chat', { input: 5_000_000 }),
    // Root s2: cheaper than s1's subtree.
    record(DAY(2026, 1, 15, 12), 's2', 'deepseek-chat', { input: 100_000 }),
    // Orphan o1: parent p-missing is not in the cells — stays top-level.
    record(DAY(2026, 1, 15, 13), 'o1', 'deepseek-chat', { input: 400_000 }),
  ]
  const pricing: Parameters<typeof attachCosts>[1] = {
    'deepseek-chat': {
      base: { inputPerMillion: 1, outputPerMillion: 1 },
      contextTiers: [], dailySlots: [], timeRules: [],
    },
    'deepseek-reasoner': {
      base: { inputPerMillion: 1, outputPerMillion: 1 },
      contextTiers: [], dailySlots: [], timeRules: [],
    },
  }
  const meta = new Map<string, SessionMetaEntry>(Object.entries({
    s1: { title: 'Root session', cwd: '/work/app' },
    c1: { cwd: '/work/app', parentSession: 's1' },
    g1: { parentSession: 'c1' },
    s2: { title: 'Other work', cwd: '/work/app' },
    o1: { title: 'Orphan', parentSession: 'p-missing' },
  }))
  const costed = (): CostedSummary => attachCosts({ dataDir: '/x', ...summarizeRecords(records) }, pricing)

  it('merges nested subagents into the topmost root', () => {
    const rows = buildSessionRows(costed(), meta, 20)
    const ids = rows.map(row => row.sessionId)
    // g1 folds into c1 which folds into s1; o1's parent is missing → top.
    // Subagents never surface as rows of their own.
    expect(ids).toEqual(['s1', 'o1', 's2'])
    const s1 = rows[0]!
    // The root row carries the whole subtree: 1M + 2M + 3M + 5M input.
    expect(s1.totals.inputTokens).toBe(11_000_000)
    expect(s1.childCount).toBe(2)
    // The root's identity wins (children ride under it).
    expect(s1.title).toBe('Root session')
  })

  it('sorts by cost descending and truncates top-N after the fold', () => {
    const rows = buildSessionRows(costed(), meta, 2)
    expect(rows).toHaveLength(2)
    // s1's subtree (¥11) ranks first; the cut must see the folded ranking,
    // so a parent whose rank comes from its children is never dropped.
    expect(rows[0]!.sessionId).toBe('s1')
    expect(rows[1]!.sessionId).toBe('o1')
  })

  it('keeps the sum invariant (fold never loses rows)', () => {
    const summary = costed()
    const rows = buildSessionRows(summary, meta, 20)
    let input = 0
    let requests = 0
    for (const row of rows) {
      input += row.totals.inputTokens
      requests += row.totals.requests
    }
    expect(input).toBe(summary.total.inputTokens)
    expect(requests).toBe(summary.total.requests)
  })

  it('cuts a parent cycle defensively: every cycle member stays its own root', () => {
    const cycleRecords = [
      record(DAY(2026, 1, 15, 9), 'a', 'deepseek-chat', { input: 10 }),
      record(DAY(2026, 1, 15, 9), 'b', 'deepseek-chat', { input: 20 }),
    ]
    const cycleMeta = new Map<string, SessionMetaEntry>(Object.entries({
      a: { parentSession: 'b' },
      b: { parentSession: 'a' },
    }))
    const summary = attachCosts({ dataDir: '/x', ...summarizeRecords(cycleRecords) }, pricing)
    const rows = buildSessionRows(summary, cycleMeta, 20)
    // Both survive as top-level rows (the walk stops on the revisit); the
    // sum is untouched either way.
    expect(rows.map(row => row.sessionId).sort()).toEqual(['a', 'b'])
  })
})
