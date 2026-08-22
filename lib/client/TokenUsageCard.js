import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The token-usage card on the Plugins configuration tab: a collapsible row
 * whose header names the plugin over a one-line description of what its
 * settings govern, disclosing the data-directory control and the mirror
 * region pick (`domestic` gitee / `overseas` github) when open. The card owns
 * everything inside it — chrome, controls, and copy — per the keyed-slot
 * contract; the tab only dispatches it under the `token-usage` namespace key.
 *
 * Renders nothing while the namespace is unavailable: a deployment that did
 * not compose the host half shows no trace of the card. A region change takes
 * effect live (the host re-syncs the pricing mirror); a directory change the
 * guard refuses while conversations run shows the wait-for-them notice on the
 * failure line, and one that lands migrates the data across under a live
 * progress bar that locks the controls until it settles.
 *
 * @module token-usage/client/TokenUsageCard
 */
import { useCallback, useEffect, useState } from 'react';
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { FULL_SYNC_PATH } from "../wire.js";
import css from './TokenUsageCard.module.css';
/**
 * Render the token-usage settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function TokenUsageCard(props) {
    const [open, setOpen] = useState(false);
    const [picking, setPicking] = useState(false);
    const { t } = props;
    const state = props.useTokenUsageCard(snapshot => snapshot);
    if (!state.available)
        return null;
    const migrating = state.migration !== undefined;
    const lockInput = !state.writable || migrating;
    const lockActions = !state.dirty || state.saving || migrating;
    /**
     * Open the shell's native folder dialog and stage the chosen path — the
     * same picker the workspace flows use, driven through the injected
     * workspace service. A dismissal leaves the staged draft exactly as it
     * was; the text input stays the fallback either way.
     */
    const browse = async () => {
        if (picking || lockInput)
            return;
        setPicking(true);
        try {
            const picked = await props.pickDirectory();
            if (picked !== null && picked !== '')
                props.editField('path', picked);
        }
        catch (_pickFailure) {
            // Leave the draft untouched; typing the path remains available.
        }
        finally {
            setPicking(false);
        }
    };
    // Manual full-sync state, polled from the host route while a scan runs.
    // The default `idle` matches the host's default; a card opening with a
    // terminal `done` / `failed` keeps it on screen until the next click.
    const [fullSync, setFullSync] = useState({ status: 'idle' });
    const fullSyncRunning = fullSync.status === 'running';
    /**
     * Fetch the current full-sync status from the host. A transport failure
     * keeps the previous view (a transient miss never blanks the bar).
     */
    const fetchFullSync = useCallback(async () => {
        try {
            const response = await fetch(FULL_SYNC_PATH, { headers: { accept: 'application/json' } });
            if (!response.ok)
                return null;
            const body = (await response.json());
            // Trust nothing that does not match the typed shape — a host running an
            // older build may answer a different status set.
            if (body.status === 'idle')
                return { status: 'idle' };
            if (body.status === 'running' || body.status === 'done') {
                if (typeof body.processed === 'number' && typeof body.total === 'number'
                    && typeof body.added === 'number' && typeof body.skipped === 'number') {
                    return { status: body.status, processed: body.processed, total: body.total, added: body.added, skipped: body.skipped };
                }
                return null;
            }
            if (body.status === 'failed' && typeof body.error === 'string') {
                return { status: 'failed', error: body.error };
            }
            return null;
        }
        catch (_pollFailure) {
            return null;
        }
    }, []);
    // Poll while a scan is in flight; the route answers 200 + status, and the
    // poll tears itself down the moment the status leaves `running`.
    useEffect(() => {
        if (!fullSyncRunning)
            return;
        let cancelled = false;
        const tick = async () => {
            const next = await fetchFullSync();
            if (cancelled || next === null)
                return;
            setFullSync(next);
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, 300);
        return () => { cancelled = true; clearInterval(timer); };
    }, [fullSyncRunning, fetchFullSync]);
    /**
     * Kick off one full scan. The button shows the request as soon as the
     * POST returns 202; the polling effect above then drives the bar until
     * the host settles into `done` or `failed`. A 409 (already running) is
     * a no-op — the polling will already see the running state.
     */
    const startFullSync = useCallback(async () => {
        try {
            const response = await fetch(FULL_SYNC_PATH, { method: 'POST' });
            if (response.status === 202) {
                setFullSync({ status: 'running', processed: 0, total: 0, added: 0, skipped: 0 });
                return;
            }
            if (response.status === 409) {
                // A scan is already running on the host; the next poll will pick it
                // up. The button is disabled while running, so this branch only
                // fires on a race the host already accepted.
                const next = await fetchFullSync();
                if (next !== null)
                    setFullSync(next);
            }
        }
        catch (_triggerFailure) {
            // The next open of the section re-tries; a transient POST failure
            // does not need its own error line.
        }
    }, [fetchFullSync]);
    return (_jsxs("li", { className: open ? `${css.card} ${css.cardOpen}` : css.card, children: [_jsxs("button", { type: "button", className: css.header, "aria-expanded": open, "aria-label": `${t(open ? 'card.collapse' : 'card.expand')}: ${t('card.title')}`, onClick: () => { setOpen(!open); }, children: [_jsxs("span", { className: css.headText, children: [_jsx("span", { className: css.name, children: t('card.title') }), _jsx("span", { className: css.description, children: t('card.description') })] }), state.dirty ? _jsx("span", { className: css.pending, children: t('card.unsaved') }) : null, _jsx(IconChevronDownOutline14, { className: open ? `${css.chevron} ${css.chevronOpen}` : css.chevron })] }), open
                ? (_jsxs("div", { className: css.body, children: [!state.writable ? _jsx("p", { className: css.note, role: "status", children: t('card.readOnly') }) : null, _jsxs("label", { className: css.field, htmlFor: "token-usage-card-path", children: [_jsx("span", { className: css.fieldLabel, children: t('card.pathLabel') }), _jsxs("span", { className: css.inputRow, children: [_jsx("input", { id: "token-usage-card-path", className: css.input, type: "text", spellCheck: false, value: state.fields.path, disabled: lockInput, onChange: event => { props.editField('path', event.target.value); } }), _jsx("button", { type: "button", className: css.browse, disabled: lockInput || picking, onClick: () => { void browse(); }, children: t(picking ? 'card.picking' : 'card.browse') })] })] }), _jsx("p", { className: css.hint, children: t('card.pathHint') }), _jsxs("label", { className: css.field, htmlFor: "token-usage-card-region", children: [_jsx("span", { className: css.fieldLabel, children: t('card.regionLabel') }), _jsxs("select", { id: "token-usage-card-region", className: css.input, value: state.fields.pricingRegion, disabled: lockInput, onChange: event => { props.editField('pricingRegion', event.target.value); }, children: [_jsx("option", { value: "", children: t('card.regionDefault') }), _jsx("option", { value: "domestic", children: t('card.region.domestic') }), _jsx("option", { value: "overseas", children: t('card.region.overseas') })] })] }), _jsxs("p", { className: css.hint, children: [t('card.hint'), state.overridden.pricingRegion ? ` ${t('card.overridden')}` : ''] }), state.migration !== undefined
                            ? (_jsxs("div", { className: css.migration, role: "status", children: [_jsx("span", { className: css.migrationLabel, children: t(state.migration.phase === 'copying' ? 'card.migratingCopy' : 'card.migratingClean')
                                            .replace('{done}', String(state.migration.done))
                                            .replace('{total}', String(state.migration.total)) }), _jsx("span", { className: css.migrationBar, children: _jsx("span", { className: css.migrationFill, style: { width: `${String(Math.round((state.migration.done / Math.max(state.migration.total, 1)) * 100))}%` } }) })] }))
                            : null, _jsxs("div", { className: css.fullSync, children: [_jsxs("div", { className: css.fullSyncHeader, children: [_jsx("span", { className: css.fullSyncTitle, children: t('card.fullSync.title') }), _jsx("span", { className: css.fullSyncHint, children: t('card.fullSync.hint') })] }), _jsx("button", { type: "button", className: css.fullSyncButton, disabled: fullSyncRunning, onClick: () => { void startFullSync(); }, children: t(fullSyncRunning ? 'card.fullSync.running' : 'card.fullSync.button') }), fullSync.status === 'running'
                                    ? (_jsxs("div", { className: css.fullSyncProgress, role: "status", children: [_jsx("span", { className: css.fullSyncProgressLabel, children: t('card.fullSync.progress', {
                                                    processed: String(fullSync.processed),
                                                    total: String(fullSync.total),
                                                    added: String(fullSync.added),
                                                    skipped: String(fullSync.skipped),
                                                }) }), _jsx("span", { className: css.fullSyncBar, children: _jsx("span", { className: css.fullSyncFill, style: { width: `${String(Math.round((fullSync.processed / Math.max(fullSync.total, 1)) * 100))}%` } }) })] }))
                                    : null, fullSync.status === 'done'
                                    ? (_jsx("p", { className: css.fullSyncResult, role: "status", children: t('card.fullSync.done', {
                                            added: String(fullSync.added),
                                            skipped: String(fullSync.skipped),
                                        }) }))
                                    : null, fullSync.status === 'failed'
                                    ? (_jsx("p", { className: css.fullSyncError, role: "status", children: t('card.fullSync.failed', { error: fullSync.error }) }))
                                    : null] }), _jsxs("div", { className: css.footer, children: [state.failed
                                    ? (_jsx("p", { className: css.failed, role: "status", children: state.refusal !== undefined
                                            ? t('card.saveBlockedSessions').replace('{count}', String(state.refusal.interactingSessions))
                                            : t('card.saveFailed') }))
                                    : null, _jsx("button", { type: "button", className: css.discard, disabled: lockActions, onClick: props.discard, children: t('card.discard') }), _jsx("button", { type: "button", className: css.save, disabled: lockActions, onClick: props.save, children: t(state.saving ? 'card.saving' : 'card.save') })] })] }))
                : null] }));
}
//# sourceMappingURL=TokenUsageCard.js.map