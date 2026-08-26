/**
 * Request-driven cost-cell inflate animation for SessionStatsChip: detects
 * new usage from summary deltas and drives WAAPI motion on the cost figure
 * and ephemeral +Δ fly labels.
 *
 * @module token-usage/client/use-cost-inflate
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { currencyViewOf } from "./format.js";
import { totalTokens } from "./day.js";
import { motionAllowed, runCostPop } from "./cost-inflate-motion.js";
import { animVars, computeIntensityFromDelta, deltaTotals, } from "./cost-inflate.js";
const MIN_WIRE_DELTA_COST = 0.000_5;
function hasUsageChurn(prev, summary) {
    const delta = deltaTotals(prev.totals, summary.total);
    if (delta.requests > 0)
        return true;
    if (summary.totalCost - prev.totalCost > MIN_WIRE_DELTA_COST)
        return true;
    return totalTokens(delta) > 0;
}
/**
 * Hook the chip uses to play costPop + deltaRise on each new request.
 * @param scopeKey - changes reset the diff baseline.
 * @param costRef - the live cost figure span (WAAPI target).
 */
export function useCostInflate(scopeKey, costRef) {
    const prevRef = useRef(null);
    const flyIdRef = useRef(0);
    const timersRef = useRef([]);
    const flyCountRef = useRef(0);
    const popAnimRef = useRef(null);
    const [flies, setFlies] = useState([]);
    const [flyOverflow, setFlyOverflow] = useState(false);
    const clearTimers = useCallback(() => {
        for (const id of timersRef.current)
            window.clearTimeout(id);
        timersRef.current = [];
    }, []);
    const schedule = useCallback((fn, ms) => {
        const id = window.setTimeout(fn, ms);
        timersRef.current.push(id);
    }, []);
    const reset = useCallback(() => {
        clearTimers();
        popAnimRef.current?.cancel();
        popAnimRef.current = null;
        prevRef.current = null;
        flyIdRef.current = 0;
        flyCountRef.current = 0;
        setFlies([]);
        setFlyOverflow(false);
    }, [clearTimers]);
    useEffect(() => {
        reset();
    }, [scopeKey, reset]);
    useEffect(() => () => { clearTimers(); }, [clearTimers]);
    const maybeClearOverflow = useCallback(() => {
        if (flyCountRef.current <= 0)
            setFlyOverflow(false);
    }, []);
    const playCostPop = useCallback((v) => {
        const el = costRef.current;
        if (el === null)
            return;
        popAnimRef.current?.cancel();
        popAnimRef.current = runCostPop(el, v);
    }, [costRef]);
    const onSummary = useCallback((summary) => {
        const nextSnapshot = {
            totals: summary.total,
            totalCost: summary.totalCost,
        };
        const prev = prevRef.current;
        prevRef.current = nextSnapshot;
        if (prev === null)
            return;
        if (!hasUsageChurn(prev, summary))
            return;
        // Reduced motion: the baseline is already stored above, so the figures
        // repaint silently — no pop, no fly, no overflow churn.
        if (!motionAllowed())
            return;
        const delta = deltaTotals(prev.totals, summary.total);
        const I = computeIntensityFromDelta(delta);
        const v = animVars(I);
        setFlyOverflow(true);
        window.requestAnimationFrame(() => { playCostPop(v); });
        const wireDeltaCost = summary.totalCost - prev.totalCost;
        if (wireDeltaCost > MIN_WIRE_DELTA_COST) {
            const view = currencyViewOf(summary);
            const text = `+${view.symbol}${(wireDeltaCost / view.rate).toFixed(2)}`;
            const id = ++flyIdRef.current;
            flyCountRef.current += 1;
            setFlies(current => [...current, { id, text, vars: v }]);
            schedule(() => {
                flyCountRef.current -= 1;
                setFlies(current => current.filter(fly => fly.id !== id));
                maybeClearOverflow();
            }, v.inflateMs + 40);
        }
        else {
            schedule(maybeClearOverflow, v.inflateMs + 40);
        }
    }, [maybeClearOverflow, playCostPop, schedule]);
    return { flies, flyOverflow, onSummary, reset };
}
//# sourceMappingURL=use-cost-inflate.js.map