// @vitest-environment node
/**
 * Pure-helper tests for the session-header stats chip: the hit-rate color
 * threshold classifier and the related edge cases.
 */
import { describe, expect, it } from 'vitest'
import { bandOf, hitRateDisplay } from '../src/client/format.ts'
import type { UsageTotals } from '../src/wire.ts'

function totals(input: number, cacheRead: number): UsageTotals {
  return {
    requests: 1,
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  }
}

describe('bandOf', () => {
  it('maps a hit rate at or above 95% into the healthy bucket', () => {
    expect(bandOf(0.95)).toBe('healthy')
    expect(bandOf(0.99)).toBe('healthy')
    expect(bandOf(1.0)).toBe('healthy')
  })

  it('maps a hit rate in the [80%, 95%) range into the lime bucket', () => {
    expect(bandOf(0.80)).toBe('lime')
    expect(bandOf(0.90)).toBe('lime')
    // The 95% boundary is inclusive on the healthy side: 0.95 sits in healthy.
    expect(bandOf(0.94)).toBe('lime')
  })

  it('maps a hit rate in the [60%, 80%) range into the amber bucket', () => {
    expect(bandOf(0.60)).toBe('amber')
    expect(bandOf(0.75)).toBe('amber')
    // The 80% boundary is inclusive on the lime side: 0.80 sits in lime.
    expect(bandOf(0.79)).toBe('amber')
  })

  it('maps a hit rate below 60% into the critical bucket', () => {
    expect(bandOf(0)).toBe('critical')
    expect(bandOf(0.5)).toBe('critical')
    expect(bandOf(0.59)).toBe('critical')
    // The 60% boundary is inclusive on the amber side: 0.60 sits in amber.
    expect(bandOf(0.5999)).toBe('critical')
  })

  it('keeps the four buckets disjoint across every boundary', () => {
    // Walking the thresholds: 0.59 critical, 0.60 amber, 0.79 amber,
    // 0.80 lime, 0.94 lime, 0.95 healthy, 0.96 healthy.
    const buckets = [
      bandOf(0.59), bandOf(0.60), bandOf(0.79),
      bandOf(0.80), bandOf(0.94),
      bandOf(0.95), bandOf(0.96),
    ]
    expect(buckets).toEqual([
      'critical', 'amber', 'amber',
      'lime', 'lime',
      'healthy', 'healthy',
    ])
  })
})

describe('hitRateDisplay', () => {
  it('reports a percent + band for a non-empty denominator', () => {
    const { text, band } = hitRateDisplay(totals(50_000, 30_000))
    // 30k / (50k + 30k) = 37.5%
    expect(text).toBe('37.5%')
    expect(band).toBe('critical')
  })

  it('lands a high hit rate in the healthy bucket', () => {
    const { band } = hitRateDisplay(totals(10_000, 360_000))
    // 360k / 370k = 97.3%
    expect(band).toBe('healthy')
  })

  it('lands an empty denominator at the amber bucket with an em-dash', () => {
    // served = 0, so rate is undefined; the chip should not paint critical
    // (red) on a brand-new session, and amber signals "no signal yet"
    // without celebrating as healthy.
    const { text, band } = hitRateDisplay(totals(0, 0))
    expect(text).toBe('—')
    expect(band).toBe('amber')
  })
})
