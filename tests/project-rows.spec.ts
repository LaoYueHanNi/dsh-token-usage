import { describe, expect, it } from 'vitest'
import { dirTailOf, projectRowsOf } from '../src/client/project-rows.ts'
import type { SessionUsageRow, UsageTotals } from '../src/wire.ts'

/** One served session row with only the fields the fold reads. */
function row(overrides: Partial<SessionUsageRow> & { cost?: number; totals?: UsageTotals }): SessionUsageRow {
  const { cost = 0, totals = { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...rest } = overrides
  return {
    sessionId: 's',
    firstTime: 0,
    lastTime: 0,
    cost,
    totals,
    ...rest,
  }
}

const TOTALS = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): UsageTotals => ({
  requests: 1,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
})

describe('dirTailOf', () => {
  it('splits on both separators and ignores trailing ones', () => {
    expect(dirTailOf('D:\\Code\\dsh-token-usage')).toBe('dsh-token-usage')
    expect(dirTailOf('/home/user/maggie/')).toBe('maggie')
    expect(dirTailOf('maggie')).toBe('maggie')
  })
})

describe('projectRowsOf', () => {
  it('folds one row per directory tail with summed totals and cost', () => {
    const projects = projectRowsOf([
      row({ sessionId: 'a', cwd: 'D:\\work\\maggie', cost: 1.5, totals: TOTALS(100, 50, 10) }),
      row({ sessionId: 'b', cwd: 'D:\\work\\maggie', cost: 0.5, totals: TOTALS(30, 20, 5) }),
    ])
    expect(projects).toHaveLength(1)
    const maggie = projects[0]!
    expect(maggie.name).toBe('maggie')
    expect(maggie.cwd).toBe('D:\\work\\maggie')
    expect(maggie.sessionCount).toBe(2)
    expect(maggie.cost).toBeCloseTo(2)
    expect(maggie.totals.inputTokens).toBe(130)
    expect(maggie.totals.outputTokens).toBe(70)
    expect(maggie.totals.cacheReadTokens).toBe(15)
  })

  it('merges same tails from different full paths under one bucket', () => {
    const projects = projectRowsOf([
      row({ sessionId: 'a', cwd: 'D:\\a\\proj' }),
      row({ sessionId: 'b', cwd: 'E:\\b\\proj' }),
    ])
    expect(projects).toHaveLength(1)
    expect(projects[0]!.name).toBe('proj')
    expect(projects[0]!.sessionCount).toBe(2)
    expect(projects[0]!.cwd).toBe('D:\\a\\proj')
  })

  it('keeps cwd-less sessions in their own unnamed bucket', () => {
    const projects = projectRowsOf([
      row({ sessionId: 'a' }),
      row({ sessionId: 'b', cwd: 'D:\\x\\app', totals: TOTALS(100) }),
    ])
    expect(projects.map(project => project.name)).toEqual(['app', ''])
    expect(projects[1]!.cwd).toBeUndefined()
  })

  it('merges the failure layer element-wise', () => {
    const withFailures = (byCode: Record<string, number>): UsageTotals => ({
      ...TOTALS(),
      failures: byCode.RATE_LIMIT ?? 0,
      failuresByCode: byCode,
    })
    const projects = projectRowsOf([
      row({ sessionId: 'a', totals: withFailures({ RATE_LIMIT: 2 }) }),
      row({ sessionId: 'b', totals: withFailures({ RATE_LIMIT: 1, TRANSPORT: 3 }) }),
    ])
    expect(projects[0]!.totals.failures).toBe(3)
    expect(projects[0]!.totals.failuresByCode).toEqual({ RATE_LIMIT: 3, TRANSPORT: 3 })
  })

  it('orders descending by total tokens', () => {
    const projects = projectRowsOf([
      row({ sessionId: 'small', cwd: 'D:\\small', totals: TOTALS(10) }),
      row({ sessionId: 'big', cwd: 'D:\\big', totals: TOTALS(1000) }),
      row({ sessionId: 'mid', cwd: 'D:\\mid', totals: TOTALS(100) }),
    ])
    expect(projects.map(project => project.name)).toEqual(['big', 'mid', 'small'])
  })

  it('preserves timing accumulators when folding sessions without mutating the inputs', () => {
    const first = row({ cwd: '/work/app', totals: { ...TOTALS(10), perfLatencyMsSum: 2000, perfLatencyCount: 1, perfStreamTpsSum: 20, perfStreamFirstMsSum: 500, perfStreamCount: 1 } })
    const second = row({ cwd: '/work/app', totals: { ...TOTALS(20), perfLatencyMsSum: 3000, perfLatencyCount: 1 } })
    expect(projectRowsOf([first, second])[0]!.totals).toMatchObject({
      perfLatencyMsSum: 5000, perfLatencyCount: 2, perfStreamTpsSum: 20, perfStreamFirstMsSum: 500, perfStreamCount: 1,
    })
    expect(first.totals.perfLatencyCount).toBe(1)
  })
})
