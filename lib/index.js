/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed); every later sync is the user's decision, via the manual
 * `/token-usage-sync` command.
 *
 * @module token-usage
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageLog } from "./usage-log.js";
import { recordFromEvent } from "./usage-record.js";
import { autoSyncIfNeeded, syncHistory } from "./sync.js";
/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config) {
    const unknown = Object.keys(config).find(key => key !== 'path');
    if (unknown !== undefined) {
        throw new Error(`TokenUsageConfig: unknown key "${unknown}"`);
    }
    if (config.path !== undefined && (typeof config.path !== 'string' || config.path.length === 0)) {
        throw new Error('TokenUsageConfig: "path" must be a non-empty string');
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
    console.log(`[token-usage] plugin loaded (data dir: ${dir})`);
}
//# sourceMappingURL=index.js.map