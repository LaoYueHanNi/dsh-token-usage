import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useEffect, useRef, useState } from 'react';
import styles from './MenuSelect.module.css';
/**
 * Render the trigger + menu popover.
 * @param props - the committed value, options, name, and change lift.
 * @returns the inline wrapper holding the trigger and, while open, the list.
 */
export function MenuSelect({ value, options, ariaLabel, onChange, grow = false }) {
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    // One ref per option row; index-aligned with the options prop.
    const optionRefs = useRef([]);
    const [open, setOpen] = useState(false);
    // The row focus roams over (index into options); a ref, not state — the
    // DOM focus itself is the source of truth, this only remembers it for
    // Enter/Space and re-opening.
    const focusIndexRef = useRef(0);
    const close = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };
    // Opening lands focus on the selected option (or the first), centered
    // in the list — native-select parity, so a long model list opens with
    // the current choice in view.
    const openMenu = () => {
        const selected = options.findIndex(option => option.value === value);
        focusIndexRef.current = selected >= 0 ? selected : 0;
        setOpen(true);
    };
    // Outside pointerdown / Escape close — QuotaButton's pattern, one
    // document listener pair while open. The outside path does NOT steal
    // focus (the user is already interacting elsewhere); Escape refocuses
    // the trigger.
    useEffect(() => {
        if (!open)
            return;
        const onPointerDown = (event) => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target) === true)
                return;
            setOpen(false);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape')
                close();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);
    // After the panel renders: focus the remembered row without scrolling,
    // then center it explicitly (a bare focus() would only kiss the edge).
    // scrollIntoView is guarded — jsdom does not implement it.
    useEffect(() => {
        if (!open)
            return;
        const button = optionRefs.current[focusIndexRef.current];
        if (button === undefined || button === null)
            return;
        button.focus({ preventScroll: true });
        if (typeof button.scrollIntoView === 'function')
            button.scrollIntoView({ block: 'center' });
    }, [open]);
    const commit = (index) => {
        const option = options[index];
        if (option === undefined)
            return;
        close();
        onChange(option.value);
    };
    const moveFocus = (index) => {
        const next = Math.max(0, Math.min(options.length - 1, index));
        focusIndexRef.current = next;
        // A plain focus: the browser scrolls the newly focused row into view
        // with minimal movement, which is what roaming wants.
        optionRefs.current[next]?.focus();
    };
    // Roving keys on the panel (events bubble from the option buttons).
    // Enter/Space are handled here with preventDefault so the UA does not
    // synthesize a second click on the focused button.
    const onPanelKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveFocus(focusIndexRef.current + 1);
        }
        else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveFocus(focusIndexRef.current - 1);
        }
        else if (event.key === 'Home') {
            event.preventDefault();
            moveFocus(0);
        }
        else if (event.key === 'End') {
            event.preventDefault();
            moveFocus(options.length - 1);
        }
        else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            commit(focusIndexRef.current);
        }
    };
    // The trigger's arrow keys open the menu too (Enter/Space come for free
    // as button clicks).
    const onTriggerKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open)
                openMenu();
        }
    };
    const selected = options.find(option => option.value === value);
    const triggerClass = [styles['trigger'], grow === true ? styles['grow'] : ''].join(' ').trim();
    return (_jsxs("span", { ref: rootRef, className: styles['wrapper'], children: [_jsx("button", { type: "button", ref: triggerRef, className: triggerClass, "aria-label": ariaLabel, "aria-expanded": open, "aria-haspopup": "listbox", onClick: () => { (open ? close() : openMenu()); }, onKeyDown: onTriggerKeyDown, children: selected?.label ?? value }), open
                ? (_jsx("div", { className: styles['panel'], role: "listbox", "aria-label": ariaLabel, onKeyDown: onPanelKeyDown, children: options.map((option, index) => {
                        const isSelected = option.value === value;
                        const optionClass = [styles['option'], isSelected ? styles['optionSelected'] : ''].join(' ').trim();
                        return (_jsxs("button", { type: "button", role: "option", 
                            // Roving focus: only code moves focus into the list, so
                            // the rows stay out of the Tab ring.
                            tabIndex: -1, ref: element => { optionRefs.current[index] = element; }, className: optionClass, "aria-selected": isSelected, onClick: () => { commit(index); }, children: [_jsx("span", { className: styles['optionLabel'], children: option.label }), isSelected ? _jsx("span", { className: styles['check'], "aria-hidden": "true", children: "\u2713" }) : null] }, option.value));
                    }) }))
                : null] }));
}
//# sourceMappingURL=MenuSelect.js.map