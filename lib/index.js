/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed). When a webServer exists, the plugin also serves the stats
 * route backing the web settings page (browser half in `src/client`).
 *
 * The pricing source is also editable from the web settings page: the
 * `token-usage` settings namespace registers through `installSettingsSection`
 * with the composition entry as its base layer. A stored change — the region
 * pick or a mirror override — takes effect live: the plugin re-resolves the
 * feed URL and re-syncs the mirror, so no restart is needed.
 *
 * @module token-usage
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { UsageLog } from "./usage-log.js";
import { resolvePricingUrl, syncCloudPricing } from "./pricing.js";
import { recordFromEvent } from "./usage-record.js";
import { autoSyncIfNeeded } from "./sync.js";
import { createStatsRoute } from "./stats-route.js";
/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config) {
    const unknown = Object.keys(config).find(key => key !== 'path' && key !== 'pricingUrl' && key !== 'pricingUrlDomestic'
        && key !== 'pricingUrlOverseas' && key !== 'pricingRegion');
    if (unknown !== undefined) {
        throw new Error(`TokenUsageConfig: unknown key "${unknown}"`);
    }
    if (config.path !== undefined && (typeof config.path !== 'string' || config.path.length === 0)) {
        throw new Error('TokenUsageConfig: "path" must be a non-empty string');
    }
    if (config.pricingUrl !== undefined && (typeof config.pricingUrl !== 'string' || config.pricingUrl.length === 0)) {
        throw new Error('TokenUsageConfig: "pricingUrl" must be a non-empty string');
    }
    if (config.pricingUrlDomestic !== undefined
        && (typeof config.pricingUrlDomestic !== 'string' || config.pricingUrlDomestic.length === 0)) {
        throw new Error('TokenUsageConfig: "pricingUrlDomestic" must be a non-empty string');
    }
    if (config.pricingUrlOverseas !== undefined
        && (typeof config.pricingUrlOverseas !== 'string' || config.pricingUrlOverseas.length === 0)) {
        throw new Error('TokenUsageConfig: "pricingUrlOverseas" must be a non-empty string');
    }
    if (config.pricingRegion !== undefined
        && config.pricingRegion !== 'domestic' && config.pricingRegion !== 'overseas') {
        throw new Error('TokenUsageConfig: "pricingRegion" must be "domestic" or "overseas"');
    }
}
/**
 * Resolve the data directory: an explicit `path` wins; otherwise
 * `$DSH_HOME/token-usage` (a blank `$DSH_HOME` counts as unset), else
 * `~/.dsh/token-usage`.
 */
export function resolveDataDir(configPath) {
    if (configPath !== undefined)
        return configPath;
    const envHome = process.env.DSH_HOME;
    const base = typeof envHome === 'string' && envHome.trim() !== ''
        ? envHome
        : join(homedir(), '.dsh');
    return join(base, 'token-usage');
}
export const name = 'token-usage';
export const inject = ['sessions', 'sessionPersistence'];
/**
 * Coalescing window for pricing re-sync requests. Startup arrives as several
 * near-simultaneous requests (the entry-config fallback and the settings
 * attach's change callback, order not guaranteed); collapsing them into one
 * fetch means a restart logs a single "pricing sync" line at the effective
 * URL even when the user picked a region.
 */
const PRICING_SYNC_COALESCE_MS = 250;
/**
 * Startup grace period: within it, a re-published section that resolves to the
 * URL the startup already synced is not fetched again. The file settings
 * provider can re-commit the same section during boot (a watcher reconcile),
 * and such a transient must never turn one startup sync into two.
 */
const PRICING_SYNC_STARTUP_GRACE_MS = 5_000;
/** The settings namespace this plugin serves; its browser card spells the same string. */
export const TOKEN_USAGE_NS = settingsNamespace('token-usage');
/** Schema resolving the `token-usage` settings section. */
export const sectionSchema = z.object({
    pricingRegion: z.union([z.const('domestic'), z.const('overseas')]),
});
/** The section-shaped view of a config: absent keys stay absent (`exactOptionalPropertyTypes`). */
function sectionOf(config) {
    return config.pricingRegion === undefined ? {} : { pricingRegion: config.pricingRegion };
}
export function apply(ctx, config = {}) {
    validateConfig(config);
    const dir = resolveDataDir(config.path);
    const log = new UsageLog(dir);
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message')
            return;
        const record = recordFromEvent(event, session.id);
        // Fire-and-forget: the log serializes appends and reports its own failures.
        void log.record(record);
    });
    // One-shot backfill for requests recorded before this plugin was installed.
    // Fire-and-forget: a failure leaves the marker unwritten and the next
    // startup retries; a crash mid-run is absorbed by the sync's dedupe.
    void autoSyncIfNeeded({ persistence: ctx.sessionPersistence, log }, dir)
        .then((result) => {
        if (result !== null) {
            console.log(`[token-usage] first-run sync: ${result.added} added, ${result.skipped} skipped`);
        }
    })
        .catch((error) => {
        console.error('[token-usage] first-run sync failed:', error);
    });
    // The pricing source: the composition entry until a settings service
    // attaches, then `setSource` repoints it at the resolved settings scope.
    // A thunk, not a snapshot — reads see the current resolution at call time.
    let pricingSource = () => sectionOf(config);
    // The feed URL the latest dispatch targeted; the startup gate reads only
    // its presence (the first sync has gone out), not the URL itself.
    let lastSyncedUrl;
    // Coalescing handle: startup requests — the entry-config fallback below and
    // the settings attach's onChange, whose arrival order is not guaranteed —
    // collapse into one sync at the latest effective URL, so a restart logs a
    // single "pricing sync" line even when the user has set a region.
    let pendingSync;
    // Within this window a section re-published to an already-synced URL is a
    // boot transient, not an edit, and must not re-fetch.
    const startupUntil = Date.now() + PRICING_SYNC_STARTUP_GRACE_MS;
    /**
     * The effective URL inputs: the composition URL overrides and explicit
     * `pricingUrl`, plus the settings-resolved section (the region pick). The
     * sections' URL fields are composition-only now the card exposes just the
     * switch, so they ride on `config` rather than `pricingSource()`. Conditional
     * spreads keep absent keys absent under `exactOptionalPropertyTypes`.
     */
    const effectiveInput = () => ({
        ...(config.pricingUrlDomestic !== undefined ? { pricingUrlDomestic: config.pricingUrlDomestic } : {}),
        ...(config.pricingUrlOverseas !== undefined ? { pricingUrlOverseas: config.pricingUrlOverseas } : {}),
        ...pricingSource(),
        ...(config.pricingUrl !== undefined ? { pricingUrl: config.pricingUrl } : {}),
    });
    /**
     * Refresh the cloud pricing mirror at the currently resolved feed URL: the
     * feed is cheap to fetch (small JSON) and the mirror is written atomically,
     * so a failed or stale fetch keeps the previous mirror and the stats page
     * keeps working. The URL resolves through resolvePricingUrl: an explicit
     * `pricingUrl` (composition) wins, otherwise `pricingRegion` picks the
     * domestic or overseas mirror.
     */
    const syncPricing = () => {
        // Resolve once and capture: the .then below runs when its fetch settles,
        // by which time a newer dispatch may have repointed `lastSyncedUrl`, so
        // the log line must read the URL this fetch actually used.
        const url = resolvePricingUrl(effectiveInput());
        lastSyncedUrl = url;
        void syncCloudPricing(dir, url)
            .then((result) => {
            console.log(`[token-usage] pricing sync (${url}): version ${result.version} (${result.models} models, ${result.aliases} aliases)`);
        })
            .catch((error) => {
            // Offline or a slow network must never break the plugin: the previous
            // mirror (if any) stays active until a later sync retries the fetch.
            console.warn('[token-usage] pricing sync failed:', error instanceof Error ? error.message : String(error));
        });
    };
    /**
     * Request a refresh of the mirror at the currently effective URL. Two
     * constraints keep one restart to exactly one fetch:
     *
     * - **Startup gate**: once the first sync has been dispatched, every request
     *   until `PRICING_SYNC_STARTUP_GRACE_MS` passes is a boot transient (the
     *   settings attach's callback, the file provider's watcher reconcile, a
     *   transient value flap) and is dropped.
     * - **Coalescing**: bursts of requests collapse into one fetch at the latest
     *   effective URL, so post-startup edits re-sync at most once per burst.
     */
    const requestSync = () => {
        if (lastSyncedUrl !== undefined && Date.now() < startupUntil)
            return;
        if (pendingSync !== undefined)
            return;
        pendingSync = setTimeout(() => {
            pendingSync = undefined;
            syncPricing();
        }, PRICING_SYNC_COALESCE_MS);
    };
    // Drop a queued sync when this plugin's fiber disposes before the window
    // closes (a reload within the first ~250ms), so no stray fetch outlives it.
    ctx.effect(() => () => {
        if (pendingSync !== undefined)
            clearTimeout(pendingSync);
    }, 'token-usage: pricing sync coalescer');
    // The stats endpoint backing the web settings page. Optional by design:
    // profiles without a webserver (headless runs) keep the logging plugin and
    // simply never mount the route; the browser half of this package shows the
    // page only when the host half serves the route.
    ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register(createStatsRoute(dir)), 'token-usage: stats route');
    });
    // Every profile composes the base bundle, whose settings-file provider
    // registers before profile plugins load, so the inject inside
    // `installSettingsSection` fires during this apply and the pricing source
    // repoints at the resolved section immediately. When no settings service is
    // mounted (standalone mounts, package tests) the inject stays dormant and
    // the entry config stays the source. A stored section that changes the
    // effective URL — a region switch — re-syncs live.
    installSettingsSection(ctx, TOKEN_USAGE_NS, sectionSchema, sectionOf(config), {
        setSource: (source) => { pricingSource = source; },
        onChange: () => { requestSync(); },
    });
    // The startup sync: coalesced with the settings attach above, so exactly one
    // "pricing sync" fetch lands per restart at the effective (settings-aware)
    // URL. Without a settings service the inject stays dormant and this is the
    // one and only startup sync.
    requestSync();
    console.log(`[token-usage] plugin loaded (data dir: ${dir})`);
}
//# sourceMappingURL=index.js.map