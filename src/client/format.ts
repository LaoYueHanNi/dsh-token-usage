/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B) and the cache hit rate. Pure functions only, shared
 * by the section and the trend chart.
 *
 * @module token-usage/client/format
 */

import type { UsageTotals } from '../wire.ts'

/** One decimal below 10, integer otherwise, trailing `.0` stripped. */
function scale(value: number): string {
  if (value >= 10) return String(Math.round(value))
  const oneDecimal = value.toFixed(1)
  return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal
}

/**
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 1 亿
 * (1e8), `xxB` from 1 亿 up with B = 10 亿 (1e9) — 1 亿 is `0.1B`, 3 亿 is
 * `0.3B`, 10 亿 is `1B`, 30 亿 is `3B`. One decimal while the scaled value is
 * below 10, integer otherwise — `950K`, `1.5M`, `50M`, `0.5B`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return scale(count / 1_000) + 'K'
  if (count < 100_000_000) return scale(count / 1_000_000) + 'M'
  return scale(count / 1_000_000_000) + 'B'
}

/** Always one decimal (stripped when `.0`), unlike {@link scale}: percentages keep their precision. */
function percent(value: number): string {
  const oneDecimal = value.toFixed(1)
  return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal
}

/**
 * Cache hit rate as display text: cache reads over served input
 * (missed input + cache reads). `—` when nothing was served.
 * @param totals - the aggregated totals.
 * @returns e.g. `87.5%`, or `—` for an empty denominator.
 */
export function formatHitRate(totals: UsageTotals): string {
  const served = totals.inputTokens + totals.cacheReadTokens
  if (served === 0) return '—'
  return `${percent(totals.cacheReadTokens / served * 100)}%`
}
