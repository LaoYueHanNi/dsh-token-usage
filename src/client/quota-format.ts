/**
 * Browser-side display formatting of the quota panel: the derived
 * remaining share, the three-stop severity band, the trigger-ring fill
 * share, the trigger tooltip figure, the reset countdown, and the money /
 * percent figures. Pure functions, shared by the button (the trigger icon
 * reads the finest-granularity window) and the panel's window columns.
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
 * monthly over balance. The trigger icon reads this one, not the worst
 * across windows: the finest unit is the constraint the session is
 * currently acting inside (a calm 5-hour window carries the icon even when
 * the weekly pool runs low). Undefined when there is no window at all.
 */
export function finestQuotaWindow(windows: readonly QuotaWindow[]): QuotaWindow | undefined {
  const rank: Record<QuotaWindow['tier'], number> = { five_hour: 0, weekly: 1, monthly: 2, balance: 3 }
  let pick: QuotaWindow | undefined
  for (const window of windows) {
    if (pick === undefined || rank[window.tier] < rank[pick.tier]) pick = window
  }
  return pick
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
