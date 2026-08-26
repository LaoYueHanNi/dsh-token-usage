/**
 * SessionStatsChip cost-cell inflate animation: per-request intensity from
 * token deltas and parameters for `costPop` / `deltaRise`. Pure functions
 * only — the chip hook owns timers and DOM.
 *
 * @module token-usage/client/cost-inflate
 */
const MISS_RATE_CAP = 0.55;
const OUT_CAP = 32_000;
/** Clamp to the unit interval. */
export function clamp01(n) {
    return Math.max(0, Math.min(1, n));
}
/** Token totals of one refresh minus the previous snapshot (non-negative). */
export function deltaTotals(prev, next) {
    return {
        requests: Math.max(0, next.requests - prev.requests),
        inputTokens: Math.max(0, next.inputTokens - prev.inputTokens),
        outputTokens: Math.max(0, next.outputTokens - prev.outputTokens),
        cacheReadTokens: Math.max(0, next.cacheReadTokens - prev.cacheReadTokens),
        cacheWriteTokens: Math.max(0, next.cacheWriteTokens - prev.cacheWriteTokens),
    };
}
/**
 * Single-step intensity from the latest request's token delta (not session
 * cumulative hit rate): `I = clamp01(0.55·norm(miss) + 0.45·norm(output))`.
 */
export function computeIntensityFromDelta(delta) {
    const served = delta.inputTokens + delta.cacheReadTokens;
    const hitRate = served > 0 ? delta.cacheReadTokens / served : 0.5;
    const miss = clamp01((1 - hitRate) / MISS_RATE_CAP);
    const out = clamp01(delta.outputTokens / OUT_CAP);
    return clamp01(0.55 * miss + 0.45 * out);
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
/** Map step intensity I to animation parameters. */
export function animVars(I) {
    const inflateMs = Math.round(lerp(1000, 1800, I));
    return {
        inflateMs,
        popScale: lerp(1.08, 1.32, I).toFixed(3),
        warnMix: `${Math.round(lerp(0, 55, I))}%`,
        flyY: `${lerp(22, 38, I).toFixed(1)}px`,
        flyX: `${((Math.random() - 0.5) * 10).toFixed(1)}px`,
    };
}
//# sourceMappingURL=cost-inflate.js.map