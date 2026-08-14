/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed); every later sync is the user's decision, via the manual
 * `/token-usage-sync` command. When a webServer exists, the plugin also
 * serves the stats route backing the web settings page (browser half in
 * `src/client`).
 *
 * @module token-usage
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageLog } from "./usage-log.js";
import { DEFAULT_PRICING_URL, readPricingTable, syncCloudPricing } from "./pricing.js";
import { recordFromEvent } from "./usage-record.js";
import { autoSyncIfNeeded, syncHistory } from "./sync.js";
import { createStatsRoute } from "./stats-route.js";
/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config) {
    const unknown = Object.keys(config).find(key => key !== 'path' && key !== 'pricingUrl');
    if (unknown !== undefined) {
        throw new Error(`TokenUsageConfig: unknown key "${unknown}"`);
    }
    if (config.path !== undefined && (typeof config.path !== 'string' || config.path.length === 0)) {
        throw new Error('TokenUsageConfig: "path" must be a non-empty string');
    }
    if (config.pricingUrl !== undefined && (typeof config.pricingUrl !== 'string' || config.pricingUrl.length === 0)) {
        throw new Error('TokenUsageConfig: "pricingUrl" must be a non-empty string');
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
export const inject = ['sessions', 'sessionPersistence', 'commands'];
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
    // Refresh the cloud pricing mirror on every startup: the feed is cheap to
    // fetch (small JSON) and the mirror is written atomically, so a failed or
    // stale fetch keeps the previous mirror and the stats page keeps working —
    // exactly like the manual /token-usage-pricing-sync, just automatic.
    void syncCloudPricing(dir, config.pricingUrl ?? DEFAULT_PRICING_URL)
        .then((result) => {
        console.log(`[token-usage] pricing sync: version ${result.version} (${result.models} models, ${result.aliases} aliases)`);
    })
        .catch((error) => {
        // Offline or a slow network must never break the startup: the previous
        // mirror (if any) stays active until a later startup or manual sync.
        console.warn('[token-usage] pricing sync failed:', error instanceof Error ? error.message : String(error));
    });
    ctx.commands.register({
        name: 'token-usage-sync',
        description: 'Manual re-sync of historical session token usage (deduped by request id)',
        handler: async (invocation) => {
            try {
                const { added, skipped } = await syncHistory({ persistence: ctx.sessionPersistence, log }, invocation.signal);
                return {
                    kind: 'success',
                    text: `Token usage sync: ${added} added, ${skipped} skipped (deduped)`,
                };
            }
            catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    return { kind: 'error', text: 'Token usage sync cancelled' };
                }
                throw error;
            }
        },
    });
    ctx.commands.register({
        name: 'token-usage-pricing',
        description: 'Show the active per-model pricing table (merged from pricing.ccsa.json and pricing.json)',
        handler: async () => {
            const pricing = await readPricingTable(dir);
            const entries = Object.entries(pricing);
            if (entries.length === 0) {
                return {
                    kind: 'success',
                    text: 'Token usage pricing: no pricing configured. Run /token-usage-pricing-sync to mirror the cloud model-price-table, and/or edit pricing.json in the data directory (¥ per million tokens: inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion).',
                };
            }
            const lines = entries.map(([model, rules]) => {
                const parts = [`input ${rules.base.inputPerMillion}`, `output ${rules.base.outputPerMillion}`];
                if (rules.base.cacheReadPerMillion !== undefined)
                    parts.push(`cache read ${rules.base.cacheReadPerMillion}`);
                if (rules.base.cacheWritePerMillion !== undefined)
                    parts.push(`cache write ${rules.base.cacheWritePerMillion}`);
                const extras = [];
                if (rules.timeRules.length > 0)
                    extras.push(`${rules.timeRules.length} time rules`);
                if (rules.contextTiers.length > 0)
                    extras.push(`${rules.contextTiers.length} context tiers`);
                if (rules.dailySlots.length > 0)
                    extras.push('peak slots');
                const suffix = extras.length > 0 ? ` (+ ${extras.join(', ')})` : '';
                return `- ${model}: ${parts.join(', ')}${suffix}`;
            });
            return {
                kind: 'success',
                text: `Token usage pricing (¥/M base rates, billed per request through time/tier/peak rules; merged from pricing.ccsa.json + pricing.json in ${dir}):\n${lines.join('\n')}`,
            };
        },
    });
    ctx.commands.register({
        name: 'token-usage-pricing-sync',
        description: 'Mirror the cloud model pricing feed (the analyzer\'s model-price-table) into the data directory',
        handler: async (invocation) => {
            try {
                const result = await syncCloudPricing(dir, config.pricingUrl ?? DEFAULT_PRICING_URL);
                // The feed stamps seconds; tolerate either unit when formatting.
                const stamp = result.updatedAt > 0 && result.updatedAt < 1e12 ? result.updatedAt * 1_000 : result.updatedAt;
                const updated = stamp > 0 ? new Date(stamp).toISOString().slice(0, 10) : 'unknown date';
                return {
                    kind: 'success',
                    text: `Token usage pricing sync: version ${result.version} (${updated}), ${result.models} models, ${result.aliases} aliases mirrored to ${join(dir, 'pricing.ccsa.json')}. Manual pricing.json entries still override the synced rates.`,
                };
            }
            catch (error) {
                if (invocation.signal.aborted
                    || (error instanceof DOMException && error.name === 'AbortError')) {
                    return { kind: 'error', text: 'Token usage pricing sync cancelled' };
                }
                return {
                    kind: 'error',
                    text: `Token usage pricing sync failed: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
    });
    // The stats endpoint backing the web settings page. Optional by design:
    // profiles without a webserver (headless runs) keep the logging plugin and
    // simply never mount the route; the browser half of this package shows the
    // page only when the host half serves the route.
    ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register(createStatsRoute(dir)), 'token-usage: stats route');
    });
    console.log(`[token-usage] plugin loaded (data dir: ${dir})`);
}
//# sourceMappingURL=index.js.map