import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { STATS_PATH } from "../wire.js";
import { dayKeyOf, shiftedDayKey, totalTokens } from "./day.js";
import { formatCost, formatHitRate, formatRate, formatTokens } from "./format.js";
import { TrendChart } from "./TrendChart.js";
import styles from './TokenUsageSection.module.css';
// Re-exported for tests and sibling consumers; the implementations live in
// the leaf modules (day / format) so the chart can share them without a cycle.
export { totalTokens } from "./day.js";
export { formatTokens, formatHitRate } from "./format.js";
/** Fetch the summary for one query string; the caller owns the failure presentation. */
async function fetchSummary(query) {
    const response = await fetch(STATS_PATH + query);
    if (!response.ok)
        throw new Error(`HTTP ${String(response.status)}`);
    const value = (await response.json());
    if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
        throw new Error('unexpected stats response');
    }
    return value;
}
/**
 * The query string of one filter selection ('' when unconstrained), or null
 * while the range is mid-edit (`from > to`): editing the two date inputs
 * one at a time passes through inverted ranges, and fetching those would
 * only flash an HTTP 400 — the request waits until the range settles.
 */
function filterQuery(filters) {
    if (filters.from !== '' && filters.to !== '' && filters.from > filters.to)
        return null;
    const params = new URLSearchParams();
    if (filters.from !== '')
        params.set('from', filters.from);
    if (filters.to !== '')
        params.set('to', filters.to);
    if (filters.model !== '')
        params.set('model', filters.model);
    return Array.from(params).length > 0 ? `?${params.toString()}` : '';
}
/** Quick-range day span in days (1 = today only, inclusive on both ends). */
const QUICK_DAYS = [1, 7, 30];
/** The day keys of one quick range: today minus (days - 1) through today. */
function quickRange(days) {
    return { from: shiftedDayKey(-(days - 1)), to: shiftedDayKey(0) };
}
/** Whether the filters exactly hold one quick range. */
function isQuickActive(days, filters) {
    const range = quickRange(days);
    return filters.from === range.from && filters.to === range.to;
}
/** One card in a metric row; `accent` renders the value in the cost color. */
function StatCard({ label, value, accent }) {
    return (_jsxs("div", { className: styles['card'], children: [_jsx("span", { className: styles['cardLabel'], children: label }), _jsx("span", { className: accent === true ? styles['cardValueCost'] : styles['cardValue'], children: value })] }));
}
/** The four base rates of one model as display text; a missing cache rate bills at the input rate. */
function billedRates(rates) {
    return {
        input: formatRate(rates.inputPerMillion),
        output: formatRate(rates.outputPerMillion),
        cacheRead: formatRate(rates.cacheReadPerMillion ?? rates.inputPerMillion),
        cacheWrite: formatRate(rates.cacheWritePerMillion ?? rates.inputPerMillion),
    };
}
/** `HH:MM-HH:MM` of one peak window (half-open, local minutes). */
function windowText(window) {
    const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return `${clock(window.startMinute)}-${clock(window.endMinute)}`;
}
/** The when-it-applies text of one peak slot: its label plus its windows. */
function slotCondition(slot, t) {
    return `${slot.label ?? t('pricing.peak')} ${slot.windows.map(windowText).join(t('pricing.windowSep'))}`;
}
/**
 * The price rows of one rate node (a time rule's or the model root's): the
 * node's own base rates, then its peak slots, then its context tiers
 * (ascending), each tier followed by the peak slots hanging on that tier —
 * mirroring {@link resolveRate}'s node chain, where a matching tier's slots
 * replace the node's and peak rates replace the node's rates wholesale.
 */
function nodePriceRows(node, t) {
    const rows = [{ condition: t('pricing.default'), rates: node.rates }];
    const tiers = [...node.tiers ?? []].sort((a, b) => a.threshold - b.threshold);
    for (const tier of tiers) {
        const tierCondition = t('pricing.tier', { threshold: formatTokens(tier.threshold) });
        rows.push({ condition: tierCondition, rates: tier.rates });
        for (const slot of tier.dailySlots ?? []) {
            rows.push({ condition: `${tierCondition} · ${slotCondition(slot, t)}`, rates: slot.rates });
        }
    }
    for (const slot of node.slots ?? []) {
        rows.push({ condition: slotCondition(slot, t), rates: slot.rates });
    }
    return rows;
}
/**
 * One model's price table: rows are billing conditions — grouped into the
 * model root (“常规”, omitted when it is the only group) and one group per
 * time rule with its date window — so tier, peak, and time-rule pricing
 * each show when they apply and what they bill. Shared by the pricing
 * dialog; the structure mirrors {@link resolveRate}'s node chain.
 */
function ModelPriceTable({ rules, t }) {
    // Groups follow resolveRate's chain: the model root, then each time rule
    // with its own tiers/slots as an isolated price world.
    const groups = [
        {
            title: rules.timeRules.length > 0 ? t('pricing.regular') : null,
            rows: nodePriceRows({ rates: rules.base, tiers: rules.contextTiers, slots: rules.dailySlots }, t),
        },
        ...rules.timeRules.map(rule => ({
            // A zero start (the “since forever” rules some feeds carry) drops
            // the bogus 1970 date and reads as “through <end>”.
            title: `${rule.label !== undefined ? `${rule.label} ` : ''}${rule.startTime > 0 ? `${dayKeyOf(new Date(rule.startTime * 1000))} ~ ` : '~ '}${dayKeyOf(new Date(rule.endTime * 1000))}`,
            rows: nodePriceRows({ rates: rule.rates, tiers: rule.contextTiers, slots: rule.dailySlots }, t),
        })),
    ];
    return (_jsx("div", { className: styles['tableWrap'], children: _jsxs("table", { className: styles['table'], "aria-label": t('pricing.title'), children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: styles['conditionHead'], children: t('pricing.condition') }), _jsxs("th", { children: [t('pricing.input'), t('pricing.perMillion')] }), _jsxs("th", { children: [t('pricing.output'), t('pricing.perMillion')] }), _jsxs("th", { children: [t('pricing.cacheRead'), t('pricing.perMillion')] }), _jsxs("th", { children: [t('pricing.cacheWrite'), t('pricing.perMillion')] })] }) }), _jsx("tbody", { children: groups.flatMap(group => [
                        ...(group.title !== null
                            ? [
                                _jsx("tr", { className: styles['groupRow'], children: _jsx("td", { colSpan: 5, children: group.title }) }, group.title),
                            ]
                            : []),
                        ...group.rows.map((row, index) => {
                            const billed = billedRates(row.rates);
                            return (_jsxs("tr", { children: [_jsx("td", { className: styles['conditionCell'], children: row.condition }), _jsxs("td", { children: ["\u00A5", billed.input] }), _jsxs("td", { children: ["\u00A5", billed.output] }), _jsxs("td", { children: ["\u00A5", billed.cacheRead] }), _jsxs("td", { children: ["\u00A5", billed.cacheWrite] })] }, `${group.title ?? ''}-${index}-${row.condition}`));
                        }),
                    ]) })] }) }));
}
/**
 * The pricing dialog of one model: a native `<dialog>` (Esc closes, focus
 * is trapped, the backdrop dims, and the top layer renders it above the
 * table's scroll shell) opened by the “定价” affordance in a model row.
 * Mounts only while a model is selected; every close path funnels through
 * the dialog's `close` event, which clears the selection and unmounts it.
 */
function PricingDialog({ model, rules, onClose, t }) {
    const dialogRef = useRef(null);
    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog !== null && !dialog.open)
            dialog.showModal();
    }, []);
    return (_jsxs("dialog", { ref: dialogRef, className: styles['dialog'], "aria-label": t('pricing.title'), onClose: onClose, 
        // A click that landed on the dialog element itself hit the backdrop
        // (the content sits in child elements), which closes like Esc does.
        onClick: event => { if (event.target === dialogRef.current)
            dialogRef.current?.close(); }, children: [_jsxs("div", { className: styles['dialogHead'], children: [_jsx("span", { className: styles['dialogTitle'], children: model }), _jsx("button", { type: "button", className: styles['dialogClose'], "aria-label": t('pricing.close'), onClick: () => dialogRef.current?.close(), children: "\u2715" })] }), _jsx(ModelPriceTable, { rules: rules, t: t })] }));
}
/** The filter bar: quick range select, day range, model select — one row. */
function FilterBar({ filters, models, onChange, t }) {
    // 'custom' when the day inputs no longer hold one of the quick ranges.
    const quickValue = QUICK_DAYS.find(days => isQuickActive(days, filters)) ?? 'custom';
    return (_jsxs("div", { className: styles['filters'], children: [_jsxs("select", { "aria-label": t('filter.quickRange'), className: styles['control'], value: quickValue, onChange: event => {
                    const days = Number(event.target.value);
                    if (days > 0)
                        onChange({ ...filters, ...quickRange(days) });
                }, children: [_jsx("option", { value: "1", children: "1d" }), _jsx("option", { value: "7", children: "7d" }), _jsx("option", { value: "30", children: "30d" }), _jsx("option", { value: "custom", children: t('filter.custom') })] }), _jsx("input", { type: "date", "aria-label": t('filter.from'), className: styles['dateControl'], value: filters.from, onChange: event => onChange({ ...filters, from: event.target.value }) }), _jsx("span", { className: styles['rangeSeparator'], children: t('filter.separator') }), _jsx("input", { type: "date", "aria-label": t('filter.to'), className: styles['dateControl'], value: filters.to, onChange: event => onChange({ ...filters, to: event.target.value }) }), _jsxs("select", { "aria-label": t('filter.model'), className: styles['modelControl'], value: filters.model, onChange: event => onChange({ ...filters, model: event.target.value }), children: [_jsx("option", { value: "", children: t('filter.allModels') }), models.map(model => _jsx("option", { value: model, children: model }, model))] })] }));
}
/**
 * Mirror the shell's root `color-scheme` onto this section's root element.
 * The shell sets it on `document.documentElement` only, so form controls
 * inside a plugin section render with the UA default (white) in dark mode;
 * scoping the property to the section fixes selects, inputs, and the
 * dialog without touching anything outside the section.
 */
function useColorSchemeMirror(rootRef) {
    useEffect(() => {
        const root = document.documentElement;
        const element = rootRef.current;
        if (element === null)
            return;
        const sync = () => {
            const scheme = root.style.colorScheme;
            if (scheme !== '')
                element.style.colorScheme = scheme;
            else
                element.style.removeProperty('color-scheme');
        };
        sync();
        // The shell rewrites the inline style on every theme switch.
        const observer = new MutationObserver(sync);
        observer.observe(root, { attributes: true, attributeFilter: ['style'] });
        return () => observer.disconnect();
    }, [rootRef]);
}
/**
 * Render the Token Usage section content column. The `t` seat arrives from
 * the registration's `locale:` declaration and follows the active locale.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel) plus the framework-injected translate seat.
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection({ t }) {
    const rootRef = useRef(null);
    useColorSchemeMirror(rootRef);
    const [state, setState] = useState({ status: 'loading' });
    // Entering the page starts on today's window (the 1d quick range).
    const [filters, setFilters] = useState(() => ({ model: '', ...quickRange(1) }));
    const [models, setModels] = useState([]);
    // The model whose pricing dialog is open (null = none). Refetched
    // summaries keep the dialog's rules in sync with the latest pricing.
    const [detailModel, setDetailModel] = useState(null);
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => { setAttempt(previous => previous + 1); }, []);
    useEffect(() => {
        const query = filterQuery(filters);
        // A mid-edit inverted range keeps the current data until it settles.
        if (query === null)
            return;
        let cancelled = false;
        setState({ status: 'loading' });
        void fetchSummary(query)
            .then((summary) => {
            if (cancelled)
                return;
            setState({ status: 'ready', summary });
            // While every model is shown, keep the option list from collapsing
            // to the filtered selection.
            if (filters.model === '')
                setModels(summary.byModel.map(row => row.model));
        })
            .catch((error) => {
            if (!cancelled) {
                setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
            }
        });
        return () => { cancelled = true; };
    }, [filters, attempt]);
    if (state.status === 'loading') {
        return (_jsxs("div", { ref: rootRef, className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: t('nav.label') }), _jsx("p", { className: styles['muted'], children: t('loading') })] }));
    }
    if (state.status === 'error') {
        return (_jsxs("div", { ref: rootRef, className: styles['section'], children: [_jsxs("div", { className: styles['head'], children: [_jsx("h2", { className: styles['title'], children: t('nav.label') }), _jsx("button", { type: "button", className: styles['button'], onClick: retry, children: t('retry') })] }), _jsx("p", { className: styles['error'], children: t('loadFailed', { message: state.message }) })] }));
    }
    const { total } = state.summary;
    return (_jsxs("div", { ref: rootRef, className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: t('nav.label') }), _jsx("p", { className: styles['muted'], children: t('dataDir', { path: state.summary.dataDir }) }), _jsx(FilterBar, { filters: filters, models: models, onChange: setFilters, t: t }), total.requests === 0
                ? (
                // One hint covers both an empty log and an empty filtered window:
                // the page opens on today (1d), so the two are indistinguishable
                // from the filtered response alone. The pricing block follows the
                // filter selection, so an empty selection renders none of it.
                _jsx("p", { className: styles['empty'], children: t('empty') }))
                : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: t('stat.requests'), value: total.requests.toLocaleString() }), _jsx(StatCard, { label: t('stat.cost'), value: formatCost(state.summary.totalCost), accent: true }), _jsx(StatCard, { label: t('stat.totalTokens'), value: formatTokens(totalTokens(total)) }), _jsx(StatCard, { label: t('stat.hitRate'), value: formatHitRate(total) })] }), _jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: t('stat.input'), value: formatTokens(total.inputTokens) }), _jsx(StatCard, { label: t('stat.output'), value: formatTokens(total.outputTokens) }), _jsx(StatCard, { label: t('stat.cacheRead'), value: formatTokens(total.cacheReadTokens) }), _jsx(StatCard, { label: t('stat.cacheWrite'), value: formatTokens(total.cacheWriteTokens) })] }), state.summary.unpricedModels.length > 0
                            ? (_jsx("p", { className: styles['warning'], role: "status", children: t('unpriced.warning', {
                                    count: String(state.summary.unpricedModels.length),
                                    models: state.summary.unpricedModels.join(', '),
                                }) }))
                            : null, _jsx(TrendChart, { rows: state.summary.byDay, t: t, ...filters.from !== '' ? { from: filters.from } : {}, ...filters.to !== '' ? { to: filters.to } : {}, ...filters.from !== '' && filters.from === filters.to ? { hours: state.summary.byHour } : {} }), state.summary.byModel.length > 0
                            ? (_jsxs(_Fragment, { children: [_jsx("h3", { className: styles['subtitle'], children: t('byModel.title') }), _jsx("div", { className: styles['tableWrap'], children: _jsxs("table", { className: styles['table'], "aria-label": t('byModel.title'), children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: styles['modelHead'], children: t('filter.model') }), _jsx("th", { children: t('stat.requests') }), _jsx("th", { children: t('stat.cost') }), _jsx("th", { children: t('stat.totalTokens') }), _jsx("th", { children: t('stat.input') }), _jsx("th", { children: t('stat.output') }), _jsx("th", { children: t('stat.cacheRead') }), _jsx("th", { children: t('stat.cacheWrite') }), _jsx("th", { children: t('stat.hitRate') })] }) }), _jsx("tbody", { children: state.summary.byModel.map(row => {
                                                        const rules = state.summary.pricing[row.model];
                                                        return (_jsxs("tr", { children: [_jsx("td", { className: styles['modelCol'], children: _jsxs("span", { className: styles['modelCell'], children: [_jsx("span", { className: styles['modelName'], children: row.model }), rules !== undefined
                                                                                ? (
                                                                                // The pricing affordance: one click opens
                                                                                // the model's detail-price dialog.
                                                                                _jsx("button", { type: "button", className: styles['pricingButton'], "aria-label": t('pricing.view', { model: row.model }), onClick: () => setDetailModel(row.model), children: t('pricing.viewShort') }))
                                                                                : (
                                                                                // The unpriced tag explains the em-dash
                                                                                // cost cell in place.
                                                                                _jsx("span", { className: styles['unpricedTag'], children: t('pricing.unpriced') }))] }) }), _jsx("td", { children: row.totals.requests.toLocaleString() }), _jsx("td", { className: rules !== undefined ? styles['costCell'] : undefined, children: rules !== undefined ? formatCost(row.cost) : '—' }), _jsx("td", { children: formatTokens(totalTokens(row.totals)) }), _jsx("td", { children: formatTokens(row.totals.inputTokens) }), _jsx("td", { children: formatTokens(row.totals.outputTokens) }), _jsx("td", { children: formatTokens(row.totals.cacheReadTokens) }), _jsx("td", { children: formatTokens(row.totals.cacheWriteTokens) }), _jsx("td", { children: formatHitRate(row.totals) })] }, row.model));
                                                    }) })] }) })] }))
                            : null, detailModel !== null && state.summary.pricing[detailModel] !== undefined
                            ? (_jsx(PricingDialog, { model: detailModel, rules: state.summary.pricing[detailModel], onClose: () => setDetailModel(null), t: t }))
                            : null] }))] }));
}
//# sourceMappingURL=TokenUsageSection.js.map