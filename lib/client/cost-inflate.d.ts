/**
 * SessionStatsChip cost-cell inflate animation: per-request intensity from
 * token deltas and parameters for `costPop` / `deltaRise`. Pure functions
 * only — the chip hook owns timers and DOM.
 *
 * @module token-usage/client/cost-inflate
 */
import type { UsageTotals } from '../wire.ts';
/** Clamp to the unit interval. */
export declare function clamp01(n: number): number;
/** Token totals of one refresh minus the previous snapshot (non-negative). */
export declare function deltaTotals(prev: UsageTotals, next: UsageTotals): UsageTotals;
/**
 * Single-step intensity from the latest request's token delta (not session
 * cumulative hit rate): `I = clamp01(0.55·norm(miss) + 0.45·norm(output))`.
 */
export declare function computeIntensityFromDelta(delta: UsageTotals): number;
/** Parameters driving `costPop` and `deltaRise` for one request step. */
export interface CostInflateVars {
    inflateMs: number;
    popScale: string;
    warnMix: string;
    flyY: string;
    flyX: string;
}
/** Map step intensity I to animation parameters. */
export declare function animVars(I: number): CostInflateVars;
//# sourceMappingURL=cost-inflate.d.ts.map