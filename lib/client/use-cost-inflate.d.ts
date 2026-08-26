/**
 * Request-driven cost-cell inflate animation for SessionStatsChip: detects
 * new usage from summary deltas and drives WAAPI motion on the cost figure
 * and ephemeral +Δ fly labels.
 *
 * @module token-usage/client/use-cost-inflate
 */
import { type RefObject } from 'react';
import type { UsageSummary } from '../wire.ts';
import { type CostInflateVars } from './cost-inflate.ts';
/** One +Δ label mid-flight. */
export interface CostDeltaFly {
    id: number;
    text: string;
    vars: CostInflateVars;
}
export interface UseCostInflateResult {
    /** Active +Δ fly labels (removed after their animation). */
    flies: readonly CostDeltaFly[];
    /** Strip gets `overflow: visible` while a fly or pop may extend outside. */
    flyOverflow: boolean;
    /** Call when a fresh chip summary lands (after first paint baseline). */
    onSummary: (summary: UsageSummary) => void;
    /** Clear baseline and in-flight flies (session / scope change). */
    reset: () => void;
}
/**
 * Hook the chip uses to play costPop + deltaRise on each new request.
 * @param scopeKey - changes reset the diff baseline.
 * @param costRef - the live cost figure span (WAAPI target).
 */
export declare function useCostInflate(scopeKey: string, costRef: RefObject<HTMLElement | null>): UseCostInflateResult;
//# sourceMappingURL=use-cost-inflate.d.ts.map