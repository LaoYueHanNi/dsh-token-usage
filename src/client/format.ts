/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B), the cache hit rate, and the cost/rate figures of the
 * pricing layer (¥ amounts and per-million-token rates). Pure functions only,
 * shared by the section and the trend chart.
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
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 10 亿
 * (1e9) — 1 亿 is `100M`, 2.5 亿 is `250M`, 9.5 亿 is `950M` — and `xxB`
 * only from 10 亿 up (B = 10 亿, no fractional-B tier): `1B`, `1.5B`, `3B`.
 * One decimal while the scaled value is below 10, integer otherwise —
 * `950K`, `1.5M`, `950M`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return scale(count / 1_000) + 'K'
  if (count < 1_000_000_000) return scale(count / 1_000_000) + 'M'
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

/** Currency symbol of the pricing layer; costs are billed in RMB. */
const COST_SYMBOL = '¥'

/**
 * Cost as display text: `¥` plus two decimals, following the analyzer's cost
 * formatting (`¥1.25`, `¥0.00`). A cost is always shown, never omitted.
 * @param cost - a non-negative cost in ¥.
 * @returns e.g. `¥1.25`.
 */
export function formatCost(cost: number): string {
  return `${COST_SYMBOL}${cost.toFixed(2)}`
}

/**
 * A per-million-token rate as display text: integral rates stay bare (`8`),
 * fractional ones keep up to four decimals with trailing zeros stripped and a
 * two-decimal minimum (`0.50`, `0.25`, `0.025`). The caller appends the `/M`
 * unit where needed.
 * @param rate - a non-negative rate in ¥ per million tokens.
 * @returns the display string.
 */
export function formatRate(rate: number): string {
  if (Number.isInteger(rate)) return String(rate)
  let s = rate.toFixed(4)
  const dot = s.indexOf('.')
  s = s.replace(/0+$/u, '')
  if (s.endsWith('.')) s += '00'
  const minEnd = dot + 3
  while (s.length < minEnd) s += '0'
  return s
}
