/**
 * Command Code adapter (Go / GOAT / Pro coding-plan subscription): the
 * 5-hour rolling window, the weekly window, and the monthly plan credits.
 *
 * Endpoints (all `GET`, Bearer with the inference key; the `/alpha`
 * control plane is fixed at the root host while inference paths vary by
 * protocol — Claude `/provider`, Codex `/provider/v1`):
 *   /alpha/whoami?limits=1                  → `org.id`, the billing scope
 *   /alpha/billing/credits[?orgId=…]        → `credits` + `windowLimits`
 *   /alpha/billing/subscriptions[?orgId=…]  → `data.planId`, period bounds
 *   /alpha/usage/summary[?since=…&orgId=…]  → `totalCost`, the period spend
 *
 * `windowLimits` sits BESIDE `credits` (a nested spelling is kept for the
 * response variant that has appeared) and only paints its two lanes while
 * `limited` is true; each lane carries `{ used, cap, resetAt }` in credits
 * with `resetAt` as epoch ms. The monthly window needs no plan table: the
 * period spend plus the three credit balances give the pool, so
 * `used = spent / (spent + monthly + purchased + free)`.
 *
 * Matching: host-only (`*.commandcode.ai`). pi-ai's catalog ships no
 * Command Code route (the community registers it under ad-hoc names like
 * `commandcode`), so a route key carries no catalog identity here — every
 * real route is a user-declared name whose base URL is the only stable
 * signal, and an empty `routes` table marks them all as host-matched.
 *
 * @module token-usage/quota/adapters/command-code
 */

import type { QuotaWindow } from '../../wire.ts'
import { amountOf, fetchJson, hostOf, numberOf, toEpochMs } from '../http.ts'
import { QuotaQueryError } from '../types.ts'
import type { QuotaAdapter, QuotaQueryResult } from '../types.ts'

/** The quota host is fixed; inference paths vary by model protocol. */
const QUOTA_ORIGIN = 'https://api.commandcode.ai'

/** planId → the panel's plan tier label; an unknown id passes through
 * verbatim rather than dropping the plan tier. */
const PLAN_NAMES: Record<string, string> = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
}

/** Whether a base URL points at the Command Code host family. */
export function isCommandCodeUrl(baseUrl: string | undefined): boolean {
  const host = hostOf(baseUrl)
  return host !== undefined && (host === 'commandcode.ai' || host.endsWith('.commandcode.ai'))
}

/** An object-shaped JSON value, else undefined. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** ISO-8601 or epoch (s/ms) → epoch ms; unparseable values drop the reset. */
function resetAtOf(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  }
  return toEpochMs(value)
}

/** A `{ used, cap, resetAt }` lane → a used-percent window, or undefined. */
function windowOf(tier: QuotaWindow['tier'], raw: unknown): QuotaWindow | undefined {
  const lane = objectOf(raw)
  if (lane === undefined) return undefined
  const cap = numberOf(lane.cap)
  const used = numberOf(lane.used)
  if (cap === undefined || cap <= 0 || used === undefined) return undefined
  const resetAt = resetAtOf(lane.resetAt)
  return {
    tier,
    usedPercent: Math.min(100, (used / cap) * 100),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/** The org scope of a whoami body (`org.id`), when the account has one. */
function orgIdOf(body: unknown): string | undefined {
  const org = objectOf(objectOf(body)?.org)
  return typeof org?.id === 'string' && org.id !== '' ? org.id : undefined
}

/** The plan/period fields a subscriptions body carries, shape-checked. */
function subscriptionOf(body: unknown): { planId?: string; periodStart?: string; periodEnd?: string } {
  const data = objectOf(objectOf(body)?.data)
  return {
    ...(typeof data?.planId === 'string' && data.planId !== '' ? { planId: data.planId } : {}),
    ...(typeof data?.currentPeriodStart === 'string' && data.currentPeriodStart !== '' ? { periodStart: data.currentPeriodStart } : {}),
    ...(typeof data?.currentPeriodEnd === 'string' && data.currentPeriodEnd !== '' ? { periodEnd: data.currentPeriodEnd } : {}),
  }
}

/** One `/alpha` control-plane path with its query string. */
function alphaUrl(path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString()
  return `${QUOTA_ORIGIN}${path}${query === '' ? '' : `?${query}`}`
}

/** The Command Code adapter: 5-hour + weekly (+ monthly) windows. */
export const commandCodeAdapter: QuotaAdapter = {
  id: 'command-code',
  label: 'Command Code',
  // No catalog route exists to own: every match is a user-declared route
  // host-matched onto commandcode.ai, so the service qualifies each
  // display name with the family label.
  routes: [],
  matches(input) {
    return isCommandCodeUrl(input.baseUrl)
  },
  async query(ctx): Promise<QuotaQueryResult> {
    const authorization = `Bearer ${ctx.apiKey}`

    // The org scope only widens the billing queries; a failed lookup keeps
    // the account-scoped endpoints answering. An auth failure means the
    // key itself is dead — that must surface instead of being swallowed.
    let orgId: string | undefined
    try {
      orgId = orgIdOf(await fetchJson(ctx, alphaUrl('/alpha/whoami', { limits: '1' }), { authorization }))
    } catch (error) {
      if (error instanceof QuotaQueryError && error.kind === 'auth') throw error
    }
    const orgParams = orgId !== undefined ? { orgId } : {}

    const creditsBody = objectOf(await fetchJson(ctx, alphaUrl('/alpha/billing/credits', orgParams), { authorization }))
    const credits = objectOf(creditsBody?.credits)
    if (credits === undefined) {
      throw new QuotaQueryError('parse', 'missing "credits" object')
    }

    const windows: QuotaWindow[] = []
    // The real responses put `windowLimits` beside `credits`; the nested
    // spelling is kept for the variant that has appeared. Both lanes paint
    // only while the account is window-limited.
    const limits = objectOf(creditsBody?.windowLimits) ?? objectOf(credits.windowLimits)
    if (limits?.limited === true) {
      const fiveHour = windowOf('five_hour', limits.fiveHour)
      if (fiveHour !== undefined) windows.push(fiveHour)
      const weekly = windowOf('weekly', limits.weekly)
      if (weekly !== undefined) windows.push(weekly)
    }

    const subscription = subscriptionOf(await fetchJson(ctx, alphaUrl('/alpha/billing/subscriptions', orgParams), { authorization }))

    // The monthly pool = what the period already spent + every credit
    // balance left; no plan-allowance table to go stale against new plans.
    const summaryParams = {
      ...(subscription.periodStart !== undefined ? { since: subscription.periodStart } : {}),
      ...orgParams,
    }
    const summaryBody = objectOf(await fetchJson(ctx, alphaUrl('/alpha/usage/summary', summaryParams), { authorization }))
    const totalCost = amountOf(summaryBody?.totalCost)
    if (totalCost === undefined) {
      throw new QuotaQueryError('parse', 'missing "totalCost" number')
    }
    const remaining = ['monthlyCredits', 'purchasedCredits', 'freeCredits']
      .reduce((sum, field) => sum + Math.max(0, amountOf(credits[field]) ?? 0), 0)
    const spent = Math.max(0, totalCost)
    const pool = spent + remaining
    const resetAt = resetAtOf(subscription.periodEnd)
    windows.push({
      tier: 'monthly',
      usedPercent: pool > 0 ? Math.min(100, (spent / pool) * 100) : 0,
      ...(resetAt !== undefined ? { resetAt } : {}),
    })

    const planId = subscription.planId ?? (typeof credits.planId === 'string' ? credits.planId : undefined)
    return {
      windows,
      ...(planId !== undefined && planId !== '' ? { planTier: PLAN_NAMES[planId] ?? planId } : {}),
    }
  },
}
