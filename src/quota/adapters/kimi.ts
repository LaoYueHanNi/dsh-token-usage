/**
 * Kimi For Coding adapter (月之暗面编程套餐): the 5-hour rolling window(s)
 * and the weekly/monthly windows of the coding-plan subscription.
 *
 * Endpoint: `GET https://api.kimi.com/coding/v1/usages` with a Bearer key.
 * The legacy response carries `limits[]` — one entry per active 5-hour
 * bucket, and there CAN be several (the window rolls per request batch) —
 * plus a top-level `usage` object for the weekly bucket. Current responses
 * serialize those amounts as strings and add `usages.limit_5h` plus monthly
 * ratio windows. Both generations are accepted; the finer-grained current
 * ratio wins when both representations are present.
 *
 * Route matching is host-first: the pi-ai `moonshotai` routes point at the
 * standard Moonshot API (api.moonshot.cn / api.moonshot.ai), which has no
 * coding-plan quota endpoint, so those must never match by route key. The
 * coding plan is identified by its api.kimi.com host — exactly the signal
 * cc-switch's `detect_provider` uses — or by the catalog route
 * `kimi-coding` (whose catalog endpoint is filled in when the profile
 * omits `baseURL`).
 *
 * @module token-usage/quota/adapters/kimi
 */

import type { QuotaWindow } from '../../wire.ts'
import { amountOf, fetchJson, hostOf, toEpochMs } from '../http.ts'
import { QuotaQueryError } from '../types.ts'
import type { QuotaAdapter, QuotaQueryResult } from '../types.ts'

/** The coding-plan host; the quota endpoint is fixed (no per-route base). */
const KIMI_HOST = 'api.kimi.com'
const QUOTA_URL = `https://${KIMI_HOST}/coding/v1/usages`

/** The pi-ai catalog route of the coding plan; moonshotai is NOT this. */
const ROUTE_KIMI_CODING = 'kimi-coding'

/** Whether a host is the Kimi coding-plan endpoint (subdomains included). */
export function isKimiHost(baseUrl: string | undefined): boolean {
  const host = hostOf(baseUrl)
  return host === KIMI_HOST || (host?.endsWith(`.${KIMI_HOST}`) ?? false)
}

/** A finite non-negative JSON amount; Kimi currently serializes these as strings. */
function nonNegativeOf(value: unknown): number | undefined {
  const parsed = amountOf(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

/** Kimi reset timestamps appear as epoch numbers or ISO-8601 strings. */
function resetAtOf(value: unknown): number | undefined {
  const numeric = nonNegativeOf(value)
  if (numeric !== undefined) return toEpochMs(numeric)
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** One legacy `{ limit, remaining|used, resetTime }` bucket → a used-percent window. */
function windowOf(tier: QuotaWindow['tier'], raw: unknown): QuotaWindow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const bucket = raw as Record<string, unknown>
  const limit = nonNegativeOf(bucket.limit)
  const remaining = nonNegativeOf(bucket.remaining)
  const used = nonNegativeOf(bucket.used)
  if (limit === undefined || limit <= 0 || (remaining === undefined && used === undefined)) return undefined
  const usedAmount = remaining !== undefined ? limit - remaining : used!
  const resetAt = resetAtOf(bucket.resetTime)
  return {
    tier,
    usedPercent: Math.min(100, Math.max(0, (usedAmount / limit) * 100)),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/** One current `{ used_ratio, reset_time }` window → the shared percent model. */
function ratioWindowOf(tier: QuotaWindow['tier'], raw: unknown): QuotaWindow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const bucket = raw as Record<string, unknown>
  const ratio = nonNegativeOf(bucket.used_ratio ?? bucket.usedRatio)
  if (ratio === undefined) return undefined
  const resetAt = resetAtOf(bucket.reset_time ?? bucket.resetTime)
  return {
    tier,
    usedPercent: Math.min(100, ratio * 100),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/** The Kimi For Coding adapter: 5-hour + weekly/monthly windows. */
export const kimiAdapter: QuotaAdapter = {
  id: 'kimi-coding-plan',
  label: 'Kimi For Coding',
  routes: [ROUTE_KIMI_CODING],
  matches: input => input.provider === ROUTE_KIMI_CODING || isKimiHost(input.baseUrl),
  async query(ctx): Promise<QuotaQueryResult> {
    const body = await fetchJson(ctx, QUOTA_URL, { authorization: `Bearer ${ctx.apiKey}` })
    if (typeof body !== 'object' || body === null) {
      throw new QuotaQueryError('parse', 'response is not an object')
    }
    const record = body as Record<string, unknown>

    // Several legacy 5-hour buckets can be live at once (the window rolls);
    // the one resetting LATEST is the freshest — the bucket the current
    // requests feed. The current `usages.limit_5h` ratio is more precise and
    // takes precedence when both representations are present.
    const buckets: QuotaWindow[] = []
    if (Array.isArray(record.limits)) {
      for (const entry of record.limits) {
        const detail = typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>).detail
          : undefined
        const window = windowOf('five_hour', detail)
        if (window !== undefined) buckets.push(window)
      }
    }
    const legacyFiveHour = buckets.length > 0
      ? buckets.reduce((latest, next) => (next.resetAt ?? 0) >= (latest.resetAt ?? 0) ? next : latest)
      : undefined
    const usages = typeof record.usages === 'object' && record.usages !== null
      ? record.usages as Record<string, unknown>
      : undefined
    const fiveHour = (usages !== undefined ? ratioWindowOf('five_hour', usages.limit_5h) : undefined)
      ?? legacyFiveHour
    const weekly = windowOf('weekly', record.usage)
    // `limit_month_code` is the coding-plan pool. `limit_month_total` is the
    // account-wide fallback for responses that do not distinguish that pool.
    const monthly = usages === undefined ? undefined
      : ratioWindowOf('monthly', usages.limit_month_code)
        ?? ratioWindowOf('monthly', usages.limit_month_total)

    const windows: QuotaWindow[] = []
    if (fiveHour !== undefined) windows.push(fiveHour)
    if (weekly !== undefined) windows.push(weekly)
    if (monthly !== undefined) windows.push(monthly)
    if (windows.length === 0) {
      throw new QuotaQueryError('parse', 'no usable limit buckets in response')
    }
    return { windows }
  },
}
