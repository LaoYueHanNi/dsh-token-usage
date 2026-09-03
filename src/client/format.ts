/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B), the cache hit rate, the cost/rate figures of the
 * pricing layer (wire amounts are RMB; the currency view converts them to
 * the region-picked display currency, ¥ or $), and the failure-pill
 * tooltip labels. Pure functions only, shared by the section and the
 * trend chart.
 *
 * @module token-usage/client/format
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageSummary, UsageTotals } from '../wire.ts'
import type { TokenUsageKey } from './locales.ts'

/** Known `LlmFailure.code`s that have a `fail.*` locale label. An unknown
 * future code is not in this map and the tooltip renders it verbatim. */
const FAILURE_CODE_LABEL_KEYS = {
  RATE_LIMIT: 'fail.RATE_LIMIT',
  SERVER: 'fail.SERVER',
  TIMEOUT: 'fail.TIMEOUT',
  TRANSPORT: 'fail.TRANSPORT',
  EMPTY_RESPONSE: 'fail.EMPTY_RESPONSE',
  QUOTA: 'fail.QUOTA',
  CONTEXT_WINDOW_EXCEEDED: 'fail.CONTEXT_WINDOW_EXCEEDED',
  INVALID_CREDENTIAL: 'fail.INVALID_CREDENTIAL',
  UNKNOWN: 'fail.UNKNOWN',
} as const satisfies Record<string, TokenUsageKey>

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
  return hitRateDisplay(totals).text
}

/**
 * The threshold bucket the chip color picks from. Four levels (worst →
 * best) along one warm→cool traffic-light arc:
 *   <60%  `critical` (red)
 *   60–80% `amber`   (orange-yellow — "needs attention")
 *   80–95% `lime`    (yellow-green — "almost there")
 *   ≥95%  `healthy` (green)
 *
 * Violet/teal were tried earlier to dodge the cost cell's warn accent,
 * but they sit on opposite sides of the hue wheel so the middle two
 * stops never read as a progression. Cost figures are now uncolored,
 * so the classic red→amber→lime→green scale is free again.
 *
 * The empty-denominator path lands in `amber` so a brand-new session
 * neither alarms (`critical`) nor celebrates (`healthy`).
 */
export type HitRateBand = 'critical' | 'amber' | 'lime' | 'healthy'

/** Hit-rate thresholds (inclusive lower bound, exclusive upper). Boundary
 * values sit in the higher tier: 0.60 is `amber`, 0.80 is `lime`, 0.95
 * is `healthy`. The numbers are guideposts, not hard cutoffs — a 78%
 * cache hit rate is still in `amber`, exactly because cache misses at
 * ~1/5 of requests is worth flagging. */
const HIT_RATE_AMBER = 0.60
const HIT_RATE_LIME = 0.80
const HIT_RATE_HEALTHY = 0.95

/** Map a 0-1 fraction to one of the four chip color buckets. */
export function bandOf(hitRate: number): HitRateBand {
  if (hitRate >= HIT_RATE_HEALTHY) return 'healthy'
  if (hitRate >= HIT_RATE_LIME) return 'lime'
  if (hitRate >= HIT_RATE_AMBER) return 'amber'
  return 'critical'
}

/** Cache hit rate broken out into a display shape: the text the user sees
 * plus the color bucket the UI maps onto it. Sessions with no served input
 * read `—` in the `amber` bucket so a fresh session never paints cold. */
export interface HitRateDisplay {
  text: string
  band: HitRateBand
}

/**
 * Compute the cache hit rate's display shape in one pass.
 * @param totals - the aggregated totals.
 * @returns `{ text, band }` — `text` is `—` for an empty denominator,
 * `band` defaults to `amber` so an unused session reads as a mild
 * "no signal yet" (neither alarming nor celebratory).
 */
export function hitRateDisplay(totals: UsageTotals): HitRateDisplay {
  const served = totals.inputTokens + totals.cacheReadTokens
  if (served === 0) return { text: '—', band: 'amber' }
  const rate = totals.cacheReadTokens / served
  return {
    text: `${percent(rate * 100)}%`,
    band: bandOf(rate),
  }
}

/**
 * How cost figures render: the symbol plus, for USD, the RMB-per-USD
 * divisor every wire amount (always RMB) divides by for display.
 */
export interface CurrencyView {
  symbol: '¥' | '$'
  /** RMB per USD; 1 in the CNY view (amounts pass through untouched). */
  rate: number
}

/** The RMB display view: amounts render as stored. */
const CNY_VIEW: CurrencyView = { symbol: '¥', rate: 1 }

/**
 * The display view of one stats summary: USD when the region pick says so
 * (amounts ÷ `usdExchangeRate`, `$` prefix), else RMB as stored.
 * @param summary - the stats payload (its `currency`/`usdExchangeRate` fields).
 * @returns the view the format functions render through.
 */
export function currencyViewOf(summary: Pick<UsageSummary, 'currency' | 'usdExchangeRate'>): CurrencyView {
  return summary.currency === 'USD' ? { symbol: '$', rate: summary.usdExchangeRate } : CNY_VIEW
}

/**
 * Cost as display text: the view's symbol plus two decimals, following the
 * analyzer's cost formatting (`¥1.25`, `$0.18`). A cost is always shown,
 * never omitted. USD divides the wire's RMB amount by the exchange rate.
 * @param cost - a non-negative cost in ¥ (as carried on the wire).
 * @param view - the display currency view.
 * @returns e.g. `¥1.25`, or `$0.18` under a rate-7 USD view.
 */
export function formatCost(cost: number, view: CurrencyView = CNY_VIEW): string {
  return `${view.symbol}${(cost / view.rate).toFixed(2)}`
}

/**
 * A per-million-token rate as display text, converted through the view:
 * integral rates stay bare (`8`, `$1.14`-style conversion applied first for
 * USD), fractional ones keep up to four decimals with trailing zeros
 * stripped and a two-decimal minimum (`0.50`, `0.25`, `0.025`). The caller
 * appends the `/M` unit and the view's symbol where needed.
 * @param rate - a non-negative rate in ¥ per million tokens.
 * @param view - the display currency view.
 * @returns the display string (symbol-less, converted for USD).
 */
export function formatRate(rate: number, view: CurrencyView = CNY_VIEW): string {
  const converted = rate / view.rate
  if (Number.isInteger(converted)) return String(converted)
  let s = converted.toFixed(4)
  const dot = s.indexOf('.')
  s = s.replace(/0+$/u, '')
  if (s.endsWith('.')) s += '00'
  const minEnd = dot + 3
  while (s.length < minEnd) s += '0'
  return s
}

/**
 * A per-million-token rate as complete display text: the view's symbol plus
 * {@link formatRate}'s converted number — what the pricing table cells render.
 * @param rate - a non-negative rate in ¥ per million tokens.
 * @param view - the display currency view.
 * @returns e.g. `¥8`, or `$1.1429` under a rate-7 USD view.
 */
export function formatRateWithSymbol(rate: number, view: CurrencyView = CNY_VIEW): string {
  return `${view.symbol}${formatRate(rate, view)}`
}

/**
 * Average first-token latency in the shell's compact duration shape:
 * one decimal under a minute (`45.2s`), `2m42s` from there on.
 * @param ms - total first-token latency.
 * @returns the display string.
 */
export function formatTtft(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${String(Math.round(s * 10) / 10)}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/**
 * Decode-throughput display figure in the shell's shape: whole tokens from
 * ten up, one decimal below (the `tok/s` unit lives in the locale template).
 * @param tokensPerSecond - tokens per second.
 * @returns the display number.
 */
export function formatSpeed(tokensPerSecond: number): string {
  const clamped = Math.max(0, tokensPerSecond)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/**
 * The failure pill's hover tooltip text: one `label ×count` line per failure
 * class, largest count first (code name ascending breaks ties), newline-joined —
 * the shell Tooltip renders `pre-line`, so each line lands on its own row.
 * Known `LlmFailure.code`s map through `fail.*` locale keys (限流 / Rate
 * limited); an unknown future code renders verbatim. A legacy shape without
 * the breakdown, or an empty map, yields '' and the caller suppresses the
 * tooltip.
 * @param byCode - the per-code failure counts from the totals (may be undefined).
 * @param t - locale lookup; codes without a `fail.*` key stay verbatim.
 * @returns the multi-line tooltip label, or '' when there is nothing to show.
 */
export function failuresTooltip(
  byCode: Record<string, number> | undefined,
  t: TranslateNS<'token-usage'>,
): string {
  if (byCode === undefined) return ''
  return Object.entries(byCode)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([code, count]) => `${failureCodeLabel(code, t)} ×${count}`)
    .join('\n')
}

/** Locale label for one failure code; unknown codes stay verbatim. */
function failureCodeLabel(code: string, t: TranslateNS<'token-usage'>): string {
  if (Object.hasOwn(FAILURE_CODE_LABEL_KEYS, code)) {
    return t(FAILURE_CODE_LABEL_KEYS[code as keyof typeof FAILURE_CODE_LABEL_KEYS])
  }
  return code
}
