import { describe, expect, it } from 'vitest'
import {
  animVars,
  clamp01,
  computeIntensityFromDelta,
  deltaTotals,
} from '../src/client/cost-inflate.ts'
import type { UsageTotals } from '../src/wire.ts'

const ZERO: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

describe('cost-inflate', () => {
  it('computes high miss intensity from token delta', () => {
    const delta: UsageTotals = {
      requests: 1,
      inputTokens: 30_000,
      outputTokens: 4_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 0,
    }
    const I = computeIntensityFromDelta(delta)
    expect(I).toBeGreaterThan(0.4)
  })

  it('derives non-negative totals delta', () => {
    const prev: UsageTotals = { ...ZERO, requests: 2, outputTokens: 100 }
    const next: UsageTotals = { ...ZERO, requests: 3, outputTokens: 900 }
    expect(deltaTotals(prev, next)).toEqual({
      requests: 1,
      inputTokens: 0,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('scales animation with step intensity', () => {
    const low = animVars(0.2)
    const high = animVars(0.8)
    expect(Number(high.popScale)).toBeGreaterThan(Number(low.popScale))
    expect(high.inflateMs).toBeGreaterThan(low.inflateMs)
    expect(clamp01(1.2)).toBe(1)
  })
})
