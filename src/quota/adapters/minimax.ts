/**
 * MiniMax Coding Plan adapter (国内/国际站): the 5-hour interval window
 * and the optional weekly window.
 *
 * Endpoint: `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`
 * (international `api.minimax.io`, same path) with a Bearer key. Of the
 * `model_remains[]` entries only `model_name: "general"` is the coding
 * quota (video and friends are separate meters). Three semantic quirks
 * cc-switch documented: the percents are REMAINING shares (inverted into
 * used here), a `status == 3` lane is the server's "no entitlement here"
 * PLACEHOLDER (typically a full 100% remaining, sometimes none) that must
 * not paint a window, and business errors ride a 200 with
 * `base_resp.status_code != 0`. The status field itself is optional in
 * live responses — gating on `status == 1` would hide real windows
 * whenever it goes missing — so the guard keys on the placeholder
 * COMBINATION (status 3 with a placeholder-looking percent), not on the
 * status alone (token-monitor's live-verified shapes).
 *
 * @module token-usage/quota/adapters/minimax
 */

import type { QuotaWindow } from '../../wire.ts'
import { fetchJson, hostOf, numberOf, toEpochMs } from '../http.ts'
import { QuotaQueryError } from '../types.ts'
import type { QuotaAdapter, QuotaQueryContext, QuotaQueryResult } from '../types.ts'

/** Quota hosts of the two stations; the path is fixed on both. */
const DOMESTIC_HOST = 'api.minimaxi.com'
const INTERNATIONAL_HOST = 'api.minimax.io'
const QUOTA_PATH = '/v1/api/openplatform/coding_plan/remains'

/** The pi-ai catalog routes: `minimax` is the international station,
 * `minimax-cn` the domestic one. Host match still catches user-declared
 * routes pointing at the same endpoints. */
const ROUTE_INTERNATIONAL = 'minimax'
const ROUTE_DOMESTIC = 'minimax-cn'
const ROUTES = new Set([ROUTE_INTERNATIONAL, ROUTE_DOMESTIC])

/** Which station's quota host a route/base-URL resolves to. Host wins
 * (a catalog route can override its endpoint); the route key is the
 * fallback when the profile omitted `baseURL`. */
function quotaHost(ctx: QuotaQueryContext): string {
  const host = hostOf(ctx.baseUrl)
  if (host === INTERNATIONAL_HOST || host?.endsWith(`.${INTERNATIONAL_HOST}`)) return INTERNATIONAL_HOST
  if (host === DOMESTIC_HOST || host?.endsWith(`.${DOMESTIC_HOST}`)) return DOMESTIC_HOST
  return ctx.provider === ROUTE_INTERNATIONAL ? INTERNATIONAL_HOST : DOMESTIC_HOST
}

/** Invert a remaining-percent field into the used share; undefined stays
 * undefined (the weekly window is legitimately absent on some plans). */
function usedOf(remaining: unknown): number | undefined {
  const value = numberOf(remaining)
  if (value === undefined) return undefined
  return Math.min(100, Math.max(0, 100 - value))
}

/** Whether a lane is the server's no-entitlement placeholder: status 3
 * with a placeholder-looking percent (none, or a full 100% remaining).
 * A status-3 lane with a real percent stays visible, and a lane whose
 * status field is simply absent — as live responses can ship it — shows
 * whenever its percent exists. */
function isPlaceholderLane(entry: Record<string, unknown>, percentField: string, statusField: string): boolean {
  if (numberOf(entry[statusField]) !== 3) return false
  const percent = numberOf(entry[percentField])
  return percent === undefined || percent >= 100
}

/** The MiniMax coding-plan adapter: 5-hour + optional weekly windows. */
export const minimaxAdapter: QuotaAdapter = {
  id: 'minimax-coding-plan',
  label: 'MiniMax Coding Plan',
  routes: [ROUTE_INTERNATIONAL, ROUTE_DOMESTIC],
  matches(input) {
    if (ROUTES.has(input.provider)) return true
    const host = hostOf(input.baseUrl)
    return host !== undefined
      && (host === DOMESTIC_HOST || host.endsWith(`.${DOMESTIC_HOST}`)
        || host === INTERNATIONAL_HOST || host.endsWith(`.${INTERNATIONAL_HOST}`))
  },
  async query(ctx): Promise<QuotaQueryResult> {
    const body = await fetchJson(ctx, `https://${quotaHost(ctx)}${QUOTA_PATH}`, {
      authorization: `Bearer ${ctx.apiKey}`,
    })
    if (typeof body !== 'object' || body === null) {
      throw new QuotaQueryError('parse', 'response is not an object')
    }
    const record = body as Record<string, unknown>
    // Business errors ride HTTP 200: a non-zero status_code is the real
    // failure signal (wrong key shape, no plan, …).
    const baseResp = record.base_resp
    if (typeof baseResp === 'object' && baseResp !== null) {
      const statusCode = (baseResp as Record<string, unknown>).status_code
      if (typeof statusCode === 'number' && statusCode !== 0) {
        const message = (baseResp as Record<string, unknown>).status_msg
        throw new QuotaQueryError('http', typeof message === 'string' && message !== '' ? message : `status_code ${String(statusCode)}`)
      }
    }

    const remains = record.model_remains
    if (!Array.isArray(remains)) {
      throw new QuotaQueryError('parse', 'missing "model_remains" array')
    }
    const general = remains.find(
      entry => typeof entry === 'object' && entry !== null
        && (entry as Record<string, unknown>).model_name === 'general',
    )
    if (general === undefined) {
      throw new QuotaQueryError('parse', 'no "general" entry in "model_remains"')
    }
    const entry = general as Record<string, unknown>

    // Both lanes suppress only the status-3 placeholder combination —
    // see isPlaceholderLane. Everything else paints whenever its percent
    // exists.
    const intervalUsed = isPlaceholderLane(entry, 'current_interval_remaining_percent', 'current_interval_status')
      ? undefined
      : usedOf(entry.current_interval_remaining_percent)
    const intervalReset = toEpochMs(entry.end_time)
    const weeklyUsed = isPlaceholderLane(entry, 'current_weekly_remaining_percent', 'current_weekly_status')
      ? undefined
      : usedOf(entry.current_weekly_remaining_percent)
    const weeklyReset = toEpochMs(entry.weekly_end_time)

    const windows: QuotaWindow[] = []
    if (intervalUsed !== undefined) {
      windows.push({
        tier: 'five_hour',
        usedPercent: intervalUsed,
        ...(intervalReset !== undefined ? { resetAt: intervalReset } : {}),
      })
    }
    if (weeklyUsed !== undefined) {
      windows.push({
        tier: 'weekly',
        usedPercent: weeklyUsed,
        ...(weeklyReset !== undefined ? { resetAt: weeklyReset } : {}),
      })
    }
    if (windows.length === 0) {
      throw new QuotaQueryError('parse', '"general" entry carries no interval quota')
    }
    return { windows }
  },
}
