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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export interface Config {
    /** Data directory; defaults to `$DSH_HOME/token-usage` (`~/.dsh/token-usage`). */
    path?: string;
    /** Explicit cloud pricing feed URL mirrored on every startup; wins over
     * every region setting. Defaults to the model-price-table repository the
     * analyzer also pulls from. */
    pricingUrl?: string;
    /** Domestic (China) mirror; defaults to the gitee model-price-table feed. */
    pricingUrlDomestic?: string;
    /** Overseas mirror; defaults to the github model-price-table feed. */
    pricingUrlOverseas?: string;
    /** Which mirror to pull when `pricingUrl` is unset: `domestic` (default,
     * gitee) or `overseas` (github). Set once per install — no IP sniffing. */
    pricingRegion?: 'domestic' | 'overseas';
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
/** The settings namespace this plugin serves; its browser card spells the same string. */
export declare const TOKEN_USAGE_NS: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/**
 * The settings-facing subset of the config: the mirror region pick.
 * `pricingUrlDomestic` / `pricingUrlOverseas` stay composition-entry keys —
 * the plugin still honors them from cordis.yml for self-maintained forks, but
 * a user-facing card should not restate raw feed URLs. A descriptive line
 * about this section lives in the card's copy, not in the document.
 */
export interface SectionConfig {
    /** Mirror to pull when no explicit `pricingUrl` is set: `domestic` (default) or `overseas`. */
    pricingRegion?: 'domestic' | 'overseas';
}
/** Schema resolving the `token-usage` settings section. */
export declare const sectionSchema: z<SectionConfig>;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map