/**
 * Coloured cache-hit-rate figure: the same four-bucket mapping the
 * session-header chip uses (`format.hitRateDisplay`), so every surface
 * that shows a hit rate — the chip, the Usage-tab / settings stat
 * cards, the per-model and subagent tables — paints one gradient.
 *
 * @module token-usage/client/HitRateText
 */
import type { ReactNode } from 'react';
import type { UsageTotals } from '../wire.ts';
import { type HitRateBand } from './format.ts';
/** CSS-module class for one hit-rate colour bucket. */
export declare function bandClassOf(band: HitRateBand): string;
/**
 * Render a hit-rate percentage (or `—`) in its threshold colour.
 * @param totals - the aggregated token buckets the rate is computed from.
 */
export declare function HitRateText({ totals }: {
    totals: UsageTotals;
}): ReactNode;
//# sourceMappingURL=HitRateText.d.ts.map