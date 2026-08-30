/**
 * Range date picker (browser half): the filter bar's single date control —
 * one trigger showing the active day range plus a lightweight calendar
 * popover. The range is picked with two clicks: the first lands an anchor
 * (start or end, order does not matter), the second settles the range
 * (min/max sorted); month navigation keeps the anchor, so a range may span
 * months (navigate, click, navigate back, click). While an anchor is live,
 * hovering previews the pending range; Escape or an outside pointerdown
 * closes the popover and DISCARDS the unfinished anchor (the committed
 * filters never change on cancel). A clear affordance releases the range
 * back to unconstrained — the capability the two native date inputs it
 * replaces carried.
 *
 * The popover interaction copies QuotaButton's pattern verbatim (click
 * toggles, document pointerdown outside closes, Escape closes); the plate
 * styling mirrors its panel (menu background, inverted border, shadow,
 * z-index 100).
 *
 * @module token-usage/client/DateRangePicker
 */
import type { ReactNode } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
/** Props: the committed range ('' = unconstrained) and the change lift. */
export interface DateRangePickerProps {
    from: string;
    to: string;
    onChange: (next: {
        from: string;
        to: string;
    }) => void;
    t: TranslateNS<'token-usage'>;
}
/**
 * Render the trigger + calendar popover.
 * @param props - the committed range, the change lift, and the locale seat.
 * @returns the inline wrapper holding the trigger and, while open, the panel.
 */
export declare function DateRangePicker({ from, to, onChange, t }: DateRangePickerProps): ReactNode;
//# sourceMappingURL=DateRangePicker.d.ts.map