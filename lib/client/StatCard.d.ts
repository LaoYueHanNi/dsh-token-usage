/**
 * Shared "stat card" primitive: label on top, value underneath. Used by the
 * settings section (four primary cards + four token-bucket cards) and the
 * Usage view tab (six cards: requests / cost / total tokens / hit rate /
 * TTFT / token speed). Centralising the markup + styling means the two
 * surfaces read as one family without each one carrying its own copy of the
 * label-on-top / value-below rule.
 *
 * @module token-usage/client/StatCard
 */
import type { ReactNode } from 'react';
/** One labelled figure inside a card. */
export interface StatCardProps {
    /** The small secondary line ("token cost", "hit rate", "总 token"). */
    label: string;
    /** The bold tabular-numeric value (`1.5M`, `¥12.34`, `0.5s`). A
     * node is accepted so the hit-rate card can wrap {@link HitRateText}
     * and inherit the four-bucket colour without a second card variant. */
    value: ReactNode;
}
/**
 * Render one stat card. The value uses the standard label-primary color.
 * The label clamps to one line and ellipsizes if the column is squeezed.
 */
export declare function StatCard({ label, value }: StatCardProps): ReactNode;
//# sourceMappingURL=StatCard.d.ts.map