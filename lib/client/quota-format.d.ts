/**
 * Browser-side display formatting of the quota panel: the derived
 * remaining share, the three-stop severity band, the trigger-ring fill
 * share, the reset countdown, and the money / percent figures. Pure
 * functions, shared by the button (the trigger icon reads the
 * finest-granularity window) and the panel's window columns.
 *
 * @module token-usage/client/quota-format
 */
import type { QuotaWindow } from '../wire.ts';
/** The three color stops the quota surfaces use, best → worst. */
export type QuotaSeverity = 'ok' | 'warn' | 'exhausted';
/** Whole-number percent, one decimal kept when it exists (`62%`, `87.5%`). */
export declare function formatQuotaPercent(value: number): string;
/** A money figure with its symbol: `$6.80` / `¥110.00`. */
export declare function formatQuotaMoney(value: number, unit: 'usd' | 'cny'): string;
/**
 * The used share of one window, 0–100, whichever direction the provider
 * reported: the explicit `usedPercent`, else `remainingPercent` inverted,
 * else the balance fraction (`1 - remaining/max`). Undefined when the
 * window carries no computable ratio (a balance without a total).
 */
export declare function quotaUsedPercent(window: QuotaWindow): number | undefined;
/**
 * The remaining share of one window, 0–100 — the severity input (severity
 * reads what is LEFT, not what is spent). Mirrors {@link quotaUsedPercent}'s
 * fallback chain in the opposite direction.
 */
export declare function quotaRemainingPercent(window: QuotaWindow): number | undefined;
/** Map a remaining share (percent) to the traffic-light band: green above
 * 60, yellow 20–60, red below 20. A window with no computable ratio reads
 * by its absolute amount: an overdrawn/empty balance (≤ 0) is red,
 * anything else uncolored — a plain balance never paints alarm just for
 * lacking a total. */
export declare function quotaSeverityOf(window: QuotaWindow): QuotaSeverity;
/**
 * The FINEST-granularity window of a payload — 5-hour over weekly over
 * monthly over balance. The trigger icon reads this one, not the worst
 * across windows: the finest unit is the constraint the session is
 * currently acting inside (a calm 5-hour window carries the icon even when
 * the weekly pool runs low). Undefined when there is no window at all.
 */
export declare function finestQuotaWindow(windows: readonly QuotaWindow[]): QuotaWindow | undefined;
/**
 * Fill share of the trigger ring, 0–1. Ratio windows map the remaining
 * percent; a funded balance without a total paints a full ring (the color
 * stays neutral — amounts tint only at ≤ 0); empty / overdrawn / missing
 * windows leave the track only.
 */
export declare function quotaIconFillShare(window: QuotaWindow | undefined): number;
/**
 * The reset countdown in the shell's compact shape: `2h 14m` under a day,
 * `48m` under an hour, `1d 3h` above; a non-positive remainder reads `0m`
 * (the next poll refreshes the stale window).
 * @param resetAt - epoch ms of the window's reset.
 * @param now - epoch ms the countdown is taken at.
 */
export declare function formatResetCountdown(resetAt: number, now: number): string;
/** A wall-clock `HH:MM` stamp of an epoch-ms time (the "updated at" figure). */
export declare function formatQuotaClock(ms: number): string;
//# sourceMappingURL=quota-format.d.ts.map