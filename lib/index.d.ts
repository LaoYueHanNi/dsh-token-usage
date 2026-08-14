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
import type { Context } from '@deepseek-ai/cordis';
export interface Config {
    /** Data directory; defaults to `$DSH_HOME/token-usage` (`~/.dsh/token-usage`). */
    path?: string;
    /** Cloud pricing feed URL for /token-usage-pricing-sync; defaults to the
     * model-price-table repository the analyzer also pulls from. */
    pricingUrl?: string;
}
/** Reject stale or misspelled config keys before defaults can hide them. */
export declare function validateConfig(config: Config): void;
/**
 * Resolve the data directory: an explicit `path` wins; otherwise
 * `$DSH_HOME/token-usage` (a blank `$DSH_HOME` counts as unset), else
 * `~/.dsh/token-usage`.
 */
export declare function resolveDataDir(configPath: string | undefined): string;
export declare const name = "token-usage";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map