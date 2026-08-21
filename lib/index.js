/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed). When a webServer exists, the plugin also serves the stats
 * route backing the web settings page (browser half in `src/client`).
 *
 * The settings namespace `token-usage` registers through
 * `installSettingsSection` with the composition entry as its base layer, and
 * both of its fields take effect live. A stored region pick (or a mirror
 * override) re-resolves the feed URL and re-syncs the mirror; a stored data
 * directory switches writes to the new location and migrates every row and
 * companion file across (verbatim file copy, then source cleanup), so no
 * restart and no manual data move is needed.
 *
 * @module token-usage
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { UsageLog } from "./usage-log.js";
import { cleanSource, copyData } from "./migrate.js";
import { resolvePricingUrl, syncCloudPricing } from "./pricing.js";
import { recordFromEvent } from "./usage-record.js";
import { autoSyncIfNeeded } from "./sync.js";
import { createDirectoryGuardRoute, createMigrationRoute, createStatsRoute } from "./stats-route.js";
import { currencyOfRegion } from "./wire.js";
/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config) {
    const unknown = Object.keys(config).find(key => key !== 'path' && key !== 'pricingUrl' && key !== 'pricingUrlDomestic'
        && key !== 'pricingUrlOverseas' && key !== 'pricingRegion' && key !== 'startupDeferMs');
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
    if (config.startupDeferMs !== undefined
        && (!Number.isFinite(config.startupDeferMs) || config.startupDeferMs < 0)) {
        throw new Error('TokenUsageConfig: "startupDeferMs" must be a non-negative number');
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
    path: z.string(),
    pricingRegion: z.union([z.const('domestic'), z.const('overseas')]),
});
/** The section-shaped view of a config: absent keys stay absent (`exactOptionalPropertyTypes`). */
function sectionOf(config) {
    return {
        ...(config.path === undefined ? {} : { path: config.path }),
        ...(config.pricingRegion === undefined ? {} : { pricingRegion: config.pricingRegion }),
    };
}
/**
 * Reject an empty stored path: the schema cannot (an empty string is a valid
 * string), and it would silently disable the explicit-directory intent.
 * @param value - the resolved section, schema-valid by construction.
 */
export function validateSection(value) {
    if (value.path !== undefined && value.path.length === 0) {
        throw new Error('token-usage: "path" must be a non-empty string');
    }
}
/**
 * Count the sessions still mid-conversation: a session whose event log ends
 * inside an open turn (its last turn event is a `turn/start` with no closing
 * `turn/end`). Existence alone must not count — an idle open tab stays in the
 * store while its conversation ended, and events only append while a turn is
 * open, which is exactly the window that makes a migration unsafe.
 * @param sessions - the store's live sessions (creation order; irrelevant here).
 * @returns how many of them are mid-conversation right now.
 */
export function countInteractingSessions(sessions) {
    let interacting = 0;
    for (const session of sessions) {
        // The turn a log ends in is the one that matters; scan back to its edge.
        const events = session.events;
        for (let i = events.length - 1; i >= 0; i--) {
            const type = events[i]?.type;
            if (type === 'turn/start') {
                interacting++;
                break;
            }
            if (type === 'turn/end')
                break;
        }
    }
    return interacting;
}
/**
 * The refusal facts of one would-be directory save: `blocked` says the
 * section validator would refuse that save right now (a directory change
 * while any session is mid-conversation), `interactingSessions` counts those
 * sessions for the card's notice. The write veto ({@link validateSectionChange})
 * and the browser card's pre-save check (the `dir-guard` route) both answer
 * through this function, so the two can never disagree.
 * @param proposed - the stored path the save would land (`undefined` when the
 * save clears the override back to the default location).
 * @param guard - the running directory and mid-conversation session count.
 * @returns the verdict the card renders.
 */
export function directoryGuard(proposed, guard) {
    if (guard.runningDir === undefined)
        return { blocked: false, interactingSessions: guard.interactingSessions };
    if (resolveDataDir(proposed) === guard.runningDir)
        return { blocked: false, interactingSessions: guard.interactingSessions };
    return { blocked: guard.interactingSessions > 0, interactingSessions: guard.interactingSessions };
}
/**
 * Vet one section write before it persists: a directory change is refused
 * outright while any session is mid-conversation — their events append to the
 * source mid-copy, so a stored move could not run safely, and a silently stored
 * move that never runs is worse than a refused save. Region-only edits and
 * no-op path writes pass freely; the first start (no running directory yet)
 * adopts the stored path without migration, so it passes too.
 * @param value - the resolved section, schema-valid by construction.
 * @param guard - the running directory and mid-conversation session count.
 */
export function validateSectionChange(value, guard) {
    validateSection(value);
    const verdict = directoryGuard(value.path, guard);
    if (verdict.blocked) {
        throw new Error(`cannot change the data directory while ${String(verdict.interactingSessions)} session(s) are mid-conversation; let them finish and save again`);
    }
}
export function apply(ctx, config = {}) {
    validateConfig(config);
    // The section source: the composition entry until a settings service
    // attaches, then `setSource` repoints it at the resolved settings scope.
    // A thunk, not a snapshot — reads see the current resolution at call time,
    // so both the pricing region and the data directory follow a stored edit.
    let sectionSource = () => sectionOf(config);
    // The directory and log currently in force. Registrations below read them
    // per event and per request, so a settings-driven move swaps the running
    // directory without re-registering anything.
    let current;
    // Serialized relocations: a move runs to settlement before the next begins,
    // so two quick edits cannot interleave two migrations of the same files.
    let relocating = Promise.resolve();
    // Live migration progress, polled by the browser card while a move runs.
    let migration;
    /**
     * The directory currently in force; before the first start it resolves
     * through the section source, matching the directory `start` is about to
     * open (and the one the startup pricing sync targets).
     */
    const currentDir = () => current?.dir ?? resolveDataDir(sectionSource().path);
    /**
     * Move the running data directory as a two-phase commit: refuse while any
     * session is live (their events append to the source mid-copy), copy every
     * owned file verbatim with size verification, flip the running directory,
     * and only then remove the source files that verifiably landed. A failure
     * at any point leaves the source intact — data exists in both places or
     * only in the source, never only in the target.
     * @param nextDir - the resolved directory to move to.
     */
    const relocateTo = async (nextDir) => {
        const previous = current;
        if (previous === undefined || previous.dir === nextDir)
            return;
        // A mid-conversation session's events append to the source while the copy
        // runs; a copied file would then be stale the moment it lands. Refuse the
        // move and keep the current directory — the user lets the conversation
        // finish and retries.
        const interacting = countInteractingSessions(ctx.sessions.list());
        if (interacting > 0) {
            throw new Error(`cannot move the data directory while ${String(interacting)} session(s) are mid-conversation; let them finish and save again`);
        }
        // Quiesce the source: drain queued appends so the files on disk are final.
        await previous.log.flush();
        migration = { phase: 'copying', done: 0, total: 0 };
        const report = (progress) => {
            migration = { ...progress };
            console.log(`[token-usage] moving ${String(progress.done)}/${String(progress.total)} (${progress.phase})`);
        };
        // Phase 1: copy everything, verbatim. An existing same-named target file
        // wins (live data or a user placement); a failure aborts before the flip.
        await copyData(previous.dir, nextDir, report);
        // Phase 2: flip the running configuration. A fresh log knows the rows the
        // target already holds, so post-flip events dedupe against them.
        const log = new UsageLog(nextDir);
        await log.scan();
        current = { dir: nextDir, log };
        // Phase 3: remove the source files that verifiably landed, then the
        // emptied directory. Nothing unknown is touched.
        migration = { phase: 'cleaning', done: 0, total: 0 };
        const result = await cleanSource(previous.dir, nextDir, report);
        migration = undefined;
        console.log(`[token-usage] data directory moved to ${nextDir} (${String(result.cleaned)} files relocated)`);
    };
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
     * `pricingUrl`, plus the settings-resolved region pick. The section's URL
     * fields are composition-only now the card exposes just the switch, so
     * they ride on `config`; only `pricingRegion` crosses the settings wire
     * into the URL resolution (`path` is a directory concern, not a URL one).
     * Conditional spreads keep absent keys absent under
     * `exactOptionalPropertyTypes`.
     */
    const effectiveInput = () => ({
        ...(config.pricingUrlDomestic !== undefined ? { pricingUrlDomestic: config.pricingUrlDomestic } : {}),
        ...(config.pricingUrlOverseas !== undefined ? { pricingUrlOverseas: config.pricingUrlOverseas } : {}),
        ...(sectionSource().pricingRegion !== undefined ? { pricingRegion: sectionSource().pricingRegion } : {}),
        ...(config.pricingUrl !== undefined ? { pricingUrl: config.pricingUrl } : {}),
    });
    /**
     * Refresh the cloud pricing mirror at the currently resolved feed URL: the
     * feed is cheap to fetch (small JSON) and the mirror is written atomically,
     * so a failed or stale fetch keeps the previous mirror and the stats page
     * keeps working. The URL resolves through resolvePricingUrl: an explicit
     * `pricingUrl` (composition) wins, otherwise `pricingRegion` picks the
     * domestic or overseas mirror. The mirror lands in the directory currently
     * in force, so a completed relocation re-seeds the new location even
     * though the pricing files traveled with the migration.
     */
    const syncPricing = () => {
        // Resolve once and capture: the .then below runs when its fetch settles,
        // by which time a newer dispatch may have repointed `lastSyncedUrl`, so
        // the log line must read the URL this fetch actually used.
        const url = resolvePricingUrl(effectiveInput());
        lastSyncedUrl = url;
        void syncCloudPricing(currentDir(), url)
            .then((result) => {
            console.log(`[token-usage] pricing sync (${url}): version ${result.version} (${result.models} models, ${result.aliases} aliases, USD rate ${result.usdExchangeRate})`);
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
    /**
     * Open (or move) the running data directory at the section-resolved
     * location. Idempotent: the first call opens the directory and registers
     * the listeners and routes; a later call with a different resolved
     * directory enqueues a serialized relocation, and one with the same
     * directory is a no-op. A refusal (active sessions) or a migration
     * failure leaves the running directory unchanged.
     */
    const start = () => {
        const resolved = resolveDataDir(sectionSource().path);
        if (current !== undefined) {
            if (resolved !== current.dir) {
                relocating = relocating.then(() => relocateTo(resolved)).catch((error) => {
                    migration = undefined;
                    console.error('[token-usage] data directory move failed:', error);
                });
            }
            return;
        }
        const dir = resolved;
        const log = new UsageLog(dir);
        current = { dir, log };
        ctx.on('session/event', (session, event) => {
            if (event.type !== 'assistant/message')
                return;
            const record = recordFromEvent(event, session.id);
            // Fire-and-forget: the log serializes appends and reports its own failures.
            void current?.log.record(record);
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
        // The stats endpoint backing the web settings page. Optional by design:
        // profiles without a webserver (headless runs) keep the logging plugin
        // and simply never mount the route; the browser half of this package
        // shows the page only when the host half serves the route. Both routes
        // read the running state per request, so a relocation serves from the
        // new location and reports its own progress without re-registering.
        ctx.inject(['webServer'], (webCtx) => {
            // The display currency follows the region pick live: the thunk reads the
            // settings-resolved section at request time, so a saved region switch
            // re-prices the page's currency on the next fetch without a restart.
            webCtx.effect(() => webCtx.webServer.register(createStatsRoute(currentDir, { currency: () => currencyOfRegion(effectiveInput().pricingRegion) })), 'token-usage: stats route');
            webCtx.effect(() => webCtx.webServer.register(createMigrationRoute(() => migration)), 'token-usage: migration route');
            // The card's pre-save check for a staged directory edit: the settings
            // wire never delivers a refused write's reason (the bound scope recovers
            // silently), so this route answers the same verdict the validator will
            // enforce — before the write, with the mid-conversation count to show.
            webCtx.effect(() => webCtx.webServer.register(createDirectoryGuardRoute((proposed) => directoryGuard(proposed, {
                runningDir: current?.dir,
                interactingSessions: countInteractingSessions(ctx.sessions.list()),
            }))), 'token-usage: directory guard route');
        });
        console.log(`[token-usage] plugin loaded (data dir: ${dir})`);
    };
    // A stored section acts on both concerns live: a directory change
    // relocates, a region switch (any effective-URL change) re-syncs the
    // pricing mirror. The first start intentionally defers (see the deferred
    // startup below): the settings inject's onChange fires after setSource and
    // opens the plugin on the settings-resolved directory; with no settings
    // service the fallback timer opens the composition entry instead.
    installSettingsSection(ctx, TOKEN_USAGE_NS, sectionSchema, sectionOf(config), {
        validate: (value) => validateSectionChange(value, {
            runningDir: current?.dir,
            interactingSessions: countInteractingSessions(ctx.sessions.list()),
        }),
        setSource: (source) => { sectionSource = source; },
        onChange: () => { start(); requestSync(); },
    });
    // The bootstrap defers the first start briefly. The dsh Loader mounts every
    // profile entry CONCURRENTLY, so this plugin's apply() runs in no guaranteed
    // order relative to the base bundle's settings-file provider: probing the
    // settings service synchronously cannot tell "not attached yet" from "never
    // attached", and starting on the composition entry first would open the
    // DEFAULT directory and then relocate default → stored on every boot. So the
    // first start waits a short window for the settings inject (whose onChange
    // fires after setSource, on the settings-resolved directory), then falls
    // back to the composition entry — the idempotent start makes the deferred
    // call a no-op when the inject already won the window. No settings service
    // mounted: the inject stays dormant and the fallback is the one start.
    const startupDeferMs = config.startupDeferMs ?? 500;
    const startup = setTimeout(() => {
        start();
        requestSync();
    }, startupDeferMs);
    ctx.effect(() => () => clearTimeout(startup), 'token-usage: deferred startup');
}
//# sourceMappingURL=index.js.map