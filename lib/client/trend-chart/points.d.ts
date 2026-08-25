/**
 * Trend-chart point series: fold the three render-mode inputs (per-day
 * rows, per-hour rows, per-request series) into one discriminated-union
 * series with the mode decided at the top. Pure functions, no React.
 *
 * @module token-usage/client/trend-chart/points
 */
import type { RequestPoint, UsageDayRow, UsageHourRow } from '../../wire.ts';
/**
 * The chart series, normalised over the three render modes. Equidistant
 * modes (days, hours) advance `index` one step per point; temporal mode
 * (request buckets) attaches the wall time so the renderer scales each
 * point at its real temporal proportion of the span.
 */
export type ChartSeries = {
    mode: 'equidistant';
    points: {
        key: string;
        label: string;
        full: string;
        tokens: number;
    }[];
} | {
    mode: 'temporal';
    points: {
        key: string;
        label: string;
        full: string;
        tokens: number;
        time: number;
        count: number;
    }[];
};
interface BuildPointsInput {
    rows: readonly UsageDayRow[];
    hours?: readonly UsageHourRow[] | undefined;
    requests?: readonly RequestPoint[] | undefined;
    from?: string | undefined;
    to?: string | undefined;
}
/** Render-mode priority: request buckets outrank per-hour, which
 * outranks per-day. A session-scoped read passes `requests`; the settings
 * page passes `hours` for a single-day range; everything else plots days. */
export declare function buildChartPoints(input: BuildPointsInput): ChartSeries | null;
export {};
//# sourceMappingURL=points.d.ts.map