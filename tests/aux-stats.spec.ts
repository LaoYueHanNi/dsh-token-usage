import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRollup, writeRollup } from '../src/rollup.ts'
import { attachCosts, buildSummary, filterSummary, mergeSummaries, summarizeRecords, summaryForSessions } from '../src/stats.ts'
import type { PricingTable } from '../src/wire.ts'
import type { AuxKind, UsageRecord } from '../src/usage-record.ts'

/** Local wall time of a 2026 day. */
function day(month: number, date: number, hour = 12): number {
  return new Date(2026, month - 1, date, hour).getTime()
}

/** One conversation request row. */
function request(
  time: number,
  model: string,
  usage?: { input?: number, output?: number },
  sessionId = 's1',
): UsageRecord {
  return {
    requestId: `req-${time}-${model}`,
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

/** One auxiliary (bypass) request row: no session owner, kind + auxKind set. */
function aux(
  time: number,
  auxKind: AuxKind,
  model = 'deepseek-flash',
  usage?: { input?: number, output?: number },
): UsageRecord {
  return {
    requestId: `aux:${auxKind}:${time}`,
    time,
    sessionId: '',
    model,
    ...(usage === undefined ? {} : {
      usage: {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
      },
    }),
    kind: 'aux',
    auxKind,
  }
}

describe('summarizeRecords auxiliary dimension', () => {
  it('folds auxiliary rows into the model-scoped dimensions but not the session cells', () => {
    const at = day(1, 15, 10)
    const summary = summarizeRecords([
      request(at, 'deepseek-flash', { input: 100, output: 10 }),
      aux(at + 60_000, 'auto-review', 'deepseek-flash', { input: 40, output: 4 }),
      aux(at + 120_000, 'translation', 'deepseek-flash', { input: 10, output: 1 }),
    ])
    // Totals, day, hour, model, and rate rows include the bypass calls.
    expect(summary.total.requests).toBe(3)
    expect(summary.total.inputTokens).toBe(150)
    expect(summary.byDay[0]!.totals.requests).toBe(3)
    expect(summary.byHour).toHaveLength(1)
    expect(summary.byHour[0]!.totals.requests).toBe(3)
    expect(summary.byModel).toHaveLength(1)
    expect(summary.byModel[0]!.totals.requests).toBe(3)
    expect(summary.rateRows).toHaveLength(1)
    expect(summary.rateRows[0]!.totals.requests).toBe(3)
    // The auxiliary cells keep the (kind, day, model, rate) granule, in the
    // recorder vocabulary's fixed order.
    expect(summary.auxRows.map(row => row.auxKind)).toEqual(['auto-review', 'translation'])
    // The session dimension holds the conversation request only.
    expect(summary.bySession).toHaveLength(1)
    expect(summary.bySession[0]).toMatchObject({ sessionId: 's1', model: 'deepseek-flash' })
    expect(summary.bySession[0]!.totals.requests).toBe(1)
    // The recent window carries every row, auxiliary ones included.
    expect(summary.recent.map(row => row.requestId)).toEqual([
      `aux:translation:${at + 120_000}`,
      `aux:auto-review:${at + 60_000}`,
      `req-${at}-deepseek-flash`,
    ])
  })

  it('keeps auxiliary rows out of every per-session cell', () => {
    const summary = summarizeRecords([
      request(day(1, 15, 10), 'deepseek-flash', { input: 1 }, 's1'),
      request(day(1, 15, 11), 'deepseek-flash', { input: 2 }, 's2'),
      aux(day(1, 15, 12), 'auto-review', 'deepseek-flash', { input: 3 }),
    ])
    expect(summary.bySession.every(cell => cell.sessionId !== '')).toBe(true)
    expect(summary.bySession.map(cell => cell.sessionId).sort()).toEqual(['s1', 's2'])
    expect(summary.bySession.reduce((sum, cell) => sum + cell.totals.requests, 0)).toBe(2)
  })

  it('merges the auxiliary dimension like the rate rows', () => {
    const records = [
      request(day(1, 14, 10), 'deepseek-flash', { input: 1 }),
      aux(day(1, 14, 11), 'auto-review', 'deepseek-flash', { input: 2 }),
      aux(day(1, 15, 10), 'auto-review', 'deepseek-flash', { input: 3 }),
      aux(day(1, 15, 11), 'translation', 'glm', { input: 4 }),
    ]
    const left = summarizeRecords(records.slice(0, 2))
    const right = summarizeRecords(records.slice(2))
    expect(mergeSummaries(left, right)).toEqual(summarizeRecords(records))
  })

  it('filters auxiliary cells by day and model alongside the rate rows', () => {
    const summary = summarizeRecords([
      request(day(1, 14, 10), 'deepseek-flash'),
      aux(day(1, 14, 11), 'auto-review', 'deepseek-flash'),
      aux(day(1, 15, 10), 'translation', 'glm'),
    ])
    const scoped = { dataDir: '/data', ...summary }
    expect(filterSummary(scoped, '2026-01-15').auxRows.map(row => row.auxKind)).toEqual(['translation'])
    expect(filterSummary(scoped, undefined, undefined, 'deepseek-flash').auxRows.map(row => row.auxKind)).toEqual(['auto-review'])
  })
})

describe('attachCosts auxiliary layer', () => {
  const pricing: PricingTable = {
    'deepseek-flash': {
      base: { inputPerMillion: 1, outputPerMillion: 2 },
      contextTiers: [],
      dailySlots: [],
      timeRules: [],
    },
  }

  function summaryOf(records: readonly UsageRecord[]) {
    return { dataDir: '/data', ...summarizeRecords(records) }
  }

  it('prices the auxiliary layer without billing it twice in the total', () => {
    const costed = attachCosts(summaryOf([
      request(day(1, 15, 10), 'deepseek-flash', { input: 1_000_000 }),
      aux(day(1, 15, 11), 'auto-review', 'deepseek-flash', { input: 500_000 }),
    ]), pricing)
    // totalCost bills every billed call once: ¥1 (request) + ¥0.5 (review).
    expect(costed.totalCost).toBeCloseTo(1.5)
    expect(costed.aux.cost).toBeCloseTo(0.5)
    expect(costed.aux.total.requests).toBe(1)
    expect(costed.aux.total.inputTokens).toBe(500_000)
    expect(costed.aux.byKind).toEqual([
      {
        auxKind: 'auto-review',
        totals: expect.objectContaining({ requests: 1, inputTokens: 500_000 }),
        cost: 0.5,
        byModel: [{
          model: 'deepseek-flash',
          totals: expect.objectContaining({ requests: 1, inputTokens: 500_000 }),
          cost: 0.5,
        }],
      },
    ])
    // The by-model table includes the bypass calls (a model is real usage).
    expect(costed.byModel).toHaveLength(1)
    expect(costed.byModel[0]!.totals.requests).toBe(2)
    expect(costed.byModel[0]!.cost).toBeCloseTo(1.5)
  })

  it('orders the kind rows by the recorder vocabulary, not by amount', () => {
    const costed = attachCosts(summaryOf([
      aux(day(1, 15, 10), 'other', 'deepseek-flash', { input: 300_000 }),
      aux(day(1, 15, 11), 'auto-review', 'deepseek-flash', { input: 100_000 }),
      aux(day(1, 15, 12), 'session-title', 'deepseek-flash', { input: 100_000 }),
    ]), pricing)
    expect(costed.aux.byKind.map(row => row.auxKind)).toEqual(['auto-review', 'session-title', 'other'])
  })

  it('splits each kind by model, request-count descending then name', () => {
    const at = day(1, 15, 10)
    const costed = attachCosts(summaryOf([
      aux(at, 'auto-review', 'deepseek-flash', { input: 100_000 }),
      aux(at + 1_000, 'auto-review', 'glm-4.7', { input: 100_000 }),
      aux(at + 2_000, 'auto-review', 'glm-4.7', { input: 100_000 }),
    ]), pricing)
    expect(costed.aux.byKind).toHaveLength(1)
    const kind = costed.aux.byKind[0]!
    expect(kind.totals.requests).toBe(3)
    expect(kind.byModel.map(row => row.model)).toEqual(['glm-4.7', 'deepseek-flash'])
    expect(kind.byModel[0]!.totals.requests).toBe(2)
    expect(kind.byModel[1]!.totals.requests).toBe(1)
    // The kind aggregate is exactly the sum of its model rows.
    expect(kind.byModel.reduce((sum, row) => sum + row.totals.requests, 0)).toBe(kind.totals.requests)
    // glm has no rate in the fixture table, so only the priced model costs.
    expect(kind.byModel[0]!.cost).toBe(0)
    expect(kind.byModel[1]!.cost).toBeCloseTo(0.1)
    expect(kind.cost).toBeCloseTo(0.1)
  })

  it('folds priced alias families onto the canonical id like the by-model table', () => {
    const rates = {
      base: { inputPerMillion: 1, outputPerMillion: 2 },
      contextTiers: [],
      dailySlots: [],
      timeRules: [],
    }
    const pricing: PricingTable = {
      'glm-5.3-flash': rates,
      'auto/glm-5.3-flash': rates,
      'zcode/glm-5.3-flash': rates,
    }
    const canonical = new Map([
      ['glm-5.3-flash', 'glm-5.3-flash'],
      ['auto/glm-5.3-flash', 'glm-5.3-flash'],
      ['zcode/glm-5.3-flash', 'glm-5.3-flash'],
    ])
    const at = day(1, 15, 10)
    const costed = attachCosts(summaryOf([
      aux(at, 'session-title', 'auto/glm-5.3-flash', { input: 100_000 }),
      aux(at + 1_000, 'session-title', 'zcode/glm-5.3-flash', { input: 200_000 }),
    ]), pricing, canonical)
    // One feed family renders as one detail line under the model id.
    expect(costed.aux.byKind).toHaveLength(1)
    expect(costed.aux.byKind[0]!.byModel).toHaveLength(1)
    expect(costed.aux.byKind[0]!.byModel[0]).toEqual({
      model: 'glm-5.3-flash',
      totals: expect.objectContaining({ requests: 2, inputTokens: 300_000 }),
      cost: expect.closeTo(0.3),
    })
    // Unpriced names stay unmerged and keep their spelling.
    const mixed = attachCosts(summaryOf([
      aux(at, 'other', 'auto/glm-5.3-flash', { input: 100_000 }),
      aux(at + 1_000, 'other', 'unrouted-model', { input: 100_000 }),
    ]), pricing, canonical)
    expect(mixed.aux.byKind[0]!.byModel.map(row => row.model).sort()).toEqual([
      'glm-5.3-flash',
      'unrouted-model',
    ])
  })

  it('keys the auxiliary detail lines on the reported response model first', () => {
    const at = day(1, 15, 10)
    // Two different routed aliases whose responses were served by the same
    // reported model fold into one detail line under that name.
    const records: UsageRecord[] = [
      { ...aux(at, 'session-title', 'group/glm-5.3-flashx', { input: 100_000 }), responseModel: 'glm-5.3-flashx' },
      { ...aux(at + 1_000, 'session-title', 'zcode/GLM-5.3-Flash', { input: 200_000 }), responseModel: 'glm-5.3-flashx' },
    ]
    const costed = attachCosts(summaryOf(records), pricing)
    expect(costed.aux.byKind[0]!.byModel.map(row => row.model)).toEqual(['glm-5.3-flashx'])
    expect(costed.aux.byKind[0]!.byModel[0]!.totals.requests).toBe(2)
  })

  it('leaves the auxiliary cost at zero when pricing is unavailable', () => {
    const costed = attachCosts({ ...summaryOf([
      aux(day(1, 15, 10), 'auto-review', 'deepseek-flash', { input: 100_000 }),
    ]), costState: 'pricing-unavailable' }, pricing)
    expect(costed.totalCost).toBe(0)
    expect(costed.aux.cost).toBe(0)
    expect(costed.aux.total.requests).toBe(1)
  })
})

describe('summaryForSessions', () => {
  it('keeps a session-scoped read free of auxiliary rows', () => {
    const whole = summarizeRecords([
      request(day(1, 15, 10), 'deepseek-flash', { input: 1 }, 's1'),
      aux(day(1, 15, 11), 'auto-review', 'deepseek-flash', { input: 2 }),
    ])
    const scoped = summaryForSessions(whole, ['s1'])
    expect(scoped.auxRows).toEqual([])
    expect(scoped.total.requests).toBe(1)
    expect(scoped.bySession.map(cell => cell.sessionId)).toEqual(['s1'])
  })
})

describe('rollup auxiliary dimension', () => {
  it('reads a rollup written before the auxiliary dimension as an empty dimension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-aux-'))
    const rollup = { upto: '2026-01-15', ...summarizeRecords([request(day(1, 15, 10), 'deepseek-flash')]) }
    await writeRollup(dir, rollup)
    const raw = JSON.parse(await readFile(join(dir, 'rollup.json'), 'utf8')) as Record<string, unknown>
    delete raw.auxRows
    await writeFile(join(dir, 'rollup.json'), JSON.stringify(raw))
    const loaded = await readRollup(dir)
    expect(loaded).not.toBeNull()
    expect(loaded!.auxRows).toEqual([])
    // An absent auxiliary dimension loses no absorbed usage: the writing
    // version could not record one, so no rebuild is required.
    expect(loaded!.requiresRebuild).toBeUndefined()
  })

  it('absorbs auxiliary rows into the rollup and keeps the session table clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-aux-'))
    const today = (): Date => new Date(2026, 0, 16, 12)
    const at = day(1, 15, 10)
    const rows = [
      request(at, 'deepseek-flash', { input: 10, output: 2 }),
      aux(at + 1, 'auto-review', 'deepseek-flash', { input: 5, output: 1 }),
    ]
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const summary = await buildSummary(dir, today)
    expect(summary.total.requests).toBe(2)
    expect(summary.auxRows).toHaveLength(1)
    expect(summary.bySession).toHaveLength(1)
    const stored = await readRollup(dir)
    expect(stored?.upto).toBe('2026-01-15')
    expect(stored?.auxRows).toHaveLength(1)
    expect(stored?.auxRows[0]).toMatchObject({ auxKind: 'auto-review', model: 'deepseek-flash' })
  })
})
