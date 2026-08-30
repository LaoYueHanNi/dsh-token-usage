/**
 * Menu select (browser half): the filter bar's themed dropdown — one
 * trigger button plus a menu popover. It replaces the native `<select>`,
 * whose UA-painted option list ignores every design token (the shell sets
 * no color-scheme on plugin content, so it renders unthemed), and pairs
 * with the DateRangePicker so all three filter controls share one popover
 * language.
 *
 * Keyboard follows the listbox idiom: opening (trigger click, Enter, or
 * its arrow keys) lands focus on the SELECTED option — scrolled to the
 * center like the native select — or the first one; ArrowUp/Down and
 * Home/End roam (options are tabIndex -1, so Tab skips the list);
 * Enter/Space commits the focused row; Escape closes and returns focus
 * to the trigger; committing closes and refocuses the trigger too. An
 * outside pointerdown closes without stealing focus. The option list
 * carries listbox/option semantics with the selection marked
 * (aria-selected plus a check).
 *
 * The popover interaction copies QuotaButton's pattern verbatim (click
 * toggles, document pointerdown outside closes, Escape closes); the plate
 * styling mirrors the date-range picker's panel.
 *
 * @module token-usage/client/MenuSelect
 */
import type { ReactNode } from 'react';
/** One selectable entry of the menu. */
export interface MenuOption {
    value: string;
    label: string;
}
/** Props: the committed value, the option list, and the change lift. */
export interface MenuSelectProps {
    value: string;
    options: readonly MenuOption[];
    /** Accessible name for the trigger and the listbox popup. */
    ariaLabel: string;
    onChange: (next: string) => void;
    /** Stretch variant: shrinkable, capped, ellipsized (the model menu). */
    grow?: boolean;
}
/**
 * Render the trigger + menu popover.
 * @param props - the committed value, options, name, and change lift.
 * @returns the inline wrapper holding the trigger and, while open, the list.
 */
export declare function MenuSelect({ value, options, ariaLabel, onChange, grow }: MenuSelectProps): ReactNode;
//# sourceMappingURL=MenuSelect.d.ts.map