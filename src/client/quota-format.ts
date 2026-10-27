/**
 * Browser-side display formatting of the quota panel: the derived
 * remaining share, the three-stop severity band, the trigger-ring fill
 * share, the trigger tooltip figure, the reset countdown, and the money /
 * percent figures. Pure functions, shared by the button (the trigger icon
 * reads the finest-granularity window) and the panel's window columns.
 *
 * POOLING: a gateway may hold several keys of ONE vendor family, each
 * with its own meter but serving the same traffic. The trigger reads the
 * POOL's level (the mean of the pool's remaining shares) instead of
 * whichever window it happens to meet first, and colors it by the pool's
 * availability — one dead key no longer paints the whole vendor red,
 * while a pool with nothing left still does.
 *
 * @module token-usage/client/quota-format
 */

import type { QuotaWindow } from '../wire.ts'

/** The three color stops the quota surfaces use, best → worst. */
export type QuotaSeverity = 'ok' | 'warn' | 'exhausted'

/** Severity thresholds on the REMAINING share (percent) — the traffic-light
 * standard: above 60 reads green (plenty left), 20–60 yellow (watch it),
 * below 20 red (effectively gone). */
const REMAIN_YELLOW = 60
const REMAIN_RED = 20

/** Whole-number percent, one decimal kept when it exists (`62%`, `87.5%`). */
export function formatQuotaPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`
}

/** A money figure with its symbol: `$6.80` / `¥110.00`. */
export function formatQuotaMoney(value: number, unit: 'usd' | 'cny'): string {
  return `${unit === 'usd' ? '$' : '¥'}${value.toFixed(2)}`
}

/**
 * The used share of one window, 0–100, whichever direction the provider
 * reported: the explicit `usedPercent`, else `remainingPercent` inverted,
 * else the balance fraction (`1 - remaining/max`). Undefined when the
 * window carries no computable ratio (a balance without a total).
 */
export function quotaUsedPercent(window: QuotaWindow): number | undefined {
  if (window.usedPercent !== undefined) return clampPercent(window.usedPercent)
  if (window.remainingPercent !== undefined) return clampPercent(100 - window.remainingPercent)
  if (window.remainingValue !== undefined && window.maxValue !== undefined && window.maxValue > 0) {
    return clampPercent((1 - window.remainingValue / window.maxValue) * 100)
  }
  return undefined
}

/**
 * The remaining share of one window, 0–100 — the severity input (severity
 * reads what is LEFT, not what is spent). Mirrors {@link quotaUsedPercent}'s
 * fallback chain in the opposite direction.
 */
export function quotaRemainingPercent(window: QuotaWindow): number | undefined {
  if (window.remainingPercent !== undefined) return clampPercent(window.remainingPercent)
  if (window.usedPercent !== undefined) return clampPercent(100 - window.usedPercent)
  if (window.remainingValue !== undefined && window.maxValue !== undefined && window.maxValue > 0) {
    return clampPercent((window.remainingValue / window.maxValue) * 100)
  }
  return undefined
}

/** Map a remaining share (percent) to the traffic-light band: green above
 * 60, yellow 20–60, red below 20. A window with no computable ratio reads
 * by its absolute amount: an overdrawn/empty balance (≤ 0) is red,
 * anything else uncolored — a plain balance never paints alarm just for
 * lacking a total. */
export function quotaSeverityOf(window: QuotaWindow): QuotaSeverity {
  const remaining = quotaRemainingPercent(window)
  if (remaining === undefined) {
    return window.remainingValue !== undefined && window.remainingValue <= 0 ? 'exhausted' : 'ok'
  }
  if (remaining < REMAIN_RED) return 'exhausted'
  if (remaining <= REMAIN_YELLOW) return 'warn'
  return 'ok'
}

/**
 * The FINEST-granularity window of a payload — 5-hour over weekly over
 * monthly over balance, an `other` window (a gateway's open-named meter:
 * "Credits", "Allowance") ranking with the coarser pools it usually is.
 * The trigger icon reads this one, not the worst across windows: the
 * finest unit is the constraint the session is currently acting inside
 * (a calm 5-hour window carries the icon even when the weekly pool runs
 * low). Undefined when there is no window at all.
 */
export function finestQuotaWindow<T extends QuotaWindow>(windows: readonly T[]): T | undefined {
  const rank: Record<QuotaWindow['tier'], number> = { five_hour: 0, weekly: 1, other: 2, monthly: 3, balance: 4 }
  let pick: T | undefined
  for (const window of windows) {
    if (pick === undefined || rank[window.tier] < rank[pick.tier]) pick = window
  }
  return pick
}

/**
 * A quota window after POOLING: the windows one quota pool spends at one
 * tier collapsed into a single water level (the mean of their remaining
 * shares), plus the bookkeeping the severity band needs to tell a pool's
 * overall level from its weakest member.
 */
export interface PooledQuotaWindow extends QuotaWindow {
  /** Windows behind this level (1 = a lone window, nothing pooled). */
  peerCount: number
  /** How many of those windows sit below the red line (remaining < 20%). */
  exhaustedPeerCount: number
}

/**
 * Pool the windows of a payload: windows that NAME the same quota POOL
 * and spend the same tier (an `other` window pools only with its own
 * name) collapse into one level — their budgets are interchangeable
 * (a gateway's several keys of one vendor family), so the pool's mean
 * remaining share is the level the traffic actually feels.
 *
 * Two boundaries keep the collapse honest:
 *
 * - A window WITHOUT a pool stands alone. Single-source payloads name
 *   no pool, and a lone window pools with nothing — the mean of one
 *   window is that window.
 * - BALANCE windows never pool. Amounts are not shares: summing two
 *   purses of different currencies (or averaging them) states nothing
 *   true about either, so every balance keeps its own row.
 *
 * The order of first appearance is preserved, so the trigger still reads
 * the first (finest) level of the payload.
 */
export function poolQuotaWindows(windows: readonly QuotaWindow[]): readonly PooledQuotaWindow[] {
  const groups = new Map<string, QuotaWindow[]>()
  windows.forEach((window, index) => {
    // Pool-less windows get a key of their own (never shared).
    const key = window.pool === undefined
      ? `solo:${String(index)}`
      : `${window.pool}|${window.tier}|${window.name ?? ''}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [window])
    else group.push(window)
  })
  const pooled: PooledQuotaWindow[] = []
  for (const group of groups.values()) {
    const ratios = group
      .map(window => quotaRemainingPercent(window))
      .filter((value): value is number => value !== undefined)
    // A lone window, a balance group (amounts are not shares), or a group
    // with no computable share stays as it is.
    if (group.length === 1 || group[0]?.tier === 'balance' || ratios.length === 0) {
      for (const window of group) {
        const remaining = quotaRemainingPercent(window)
        pooled.push({
          ...window,
          peerCount: 1,
          exhaustedPeerCount: remaining !== undefined && remaining < REMAIN_RED ? 1 : 0,
        })
      }
      continue
    }
    const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    const exhausted = ratios.filter(value => value < REMAIN_RED).length
    const first = group[0] as QuotaWindow
    pooled.push({
      tier: first.tier,
      remainingPercent: mean,
      ...(first.name !== undefined ? { name: first.name } : {}),
      ...(first.pool !== undefined ? { pool: first.pool } : {}),
      peerCount: group.length,
      exhaustedPeerCount: exhausted,
    })
  }
  return pooled
}

/**
 * The severity of a POOLED window — the traffic light of a pool, not of
 * a single meter:
 *
 * - red only when EVERY window of the pool is exhausted (the pool has
 *   nothing left to route to);
 * - yellow when the pool is low (mean at or below the yellow line) or
 *   when SOME window is exhausted while others still have room (one
 *   account died, the pool still serves);
 * - green otherwise.
 *
 * A lone window keeps the plain per-window band, so single-source
 * providers read exactly as before.
 */
export function quotaPoolSeverityOf(window: PooledQuotaWindow): QuotaSeverity {
  if (window.peerCount <= 1) return quotaSeverityOf(window)
  const remaining = quotaRemainingPercent(window)
  if (remaining === undefined) return quotaSeverityOf(window)
  if (window.exhaustedPeerCount >= window.peerCount) return 'exhausted'
  if (window.exhaustedPeerCount > 0) return 'warn'
  if (remaining <= REMAIN_YELLOW) return 'warn'
  return 'ok'
}

/**
 * Fill share of the trigger ring, 0–1. Ratio windows map the remaining
 * percent; a funded balance without a total paints a full ring (the color
 * stays neutral — amounts tint only at ≤ 0); empty / overdrawn / missing
 * windows leave the track only.
 */
export function quotaIconFillShare(window: QuotaWindow | undefined): number {
  if (window === undefined) return 0
  const remaining = quotaRemainingPercent(window)
  if (remaining !== undefined) return remaining / 100
  if (window.remainingValue !== undefined && window.remainingValue > 0) return 1
  return 0
}

/**
 * The trigger tooltip's figure for one window: the remaining share as a
 * percent when a ratio exists (any direction, or the balance fraction),
 * else the remaining amount (a ratio-less balance, the DeepSeek shape);
 * undefined when the window carries neither (nothing to show beyond the
 * plain label).
 */
export function quotaTriggerFigure(window: QuotaWindow | undefined): string | undefined {
  if (window === undefined) return undefined
  const remaining = quotaRemainingPercent(window)
  if (remaining !== undefined) return formatQuotaPercent(remaining)
  if (window.remainingValue !== undefined) {
    return formatQuotaMoney(window.remainingValue, window.unit ?? 'cny')
  }
  return undefined
}

/**
 * The reset countdown in the shell's compact shape: `2h 14m` under a day,
 * `48m` under an hour, `1d 3h` above; a non-positive remainder reads `0m`
 * (the next poll refreshes the stale window).
 * @param resetAt - epoch ms of the window's reset.
 * @param now - epoch ms the countdown is taken at.
 */
export function formatResetCountdown(resetAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((resetAt - now) / 60_000))
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

/** A wall-clock `HH:MM` stamp of an epoch-ms time (the "updated at" figure). */
export function formatQuotaClock(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Clamp into 0–100. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}
