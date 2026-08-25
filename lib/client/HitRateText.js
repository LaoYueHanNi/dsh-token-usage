import { jsx as _jsx } from "react/jsx-runtime";
import { hitRateDisplay } from "./format.js";
import bands from './hit-rate-band.module.css';
/** CSS-module class for one hit-rate colour bucket. */
export function bandClassOf(band) {
    return bands[`band_${band}`] ?? '';
}
/**
 * Render a hit-rate percentage (or `—`) in its threshold colour.
 * @param totals - the aggregated token buckets the rate is computed from.
 */
export function HitRateText({ totals }) {
    const { text, band } = hitRateDisplay(totals);
    return _jsx("span", { className: bandClassOf(band), children: text });
}
//# sourceMappingURL=HitRateText.js.map