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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type DirectoryGuardView } from './wire.ts';
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
    /** How long the first start waits for a settings service to repoint the
     * section source before falling back to the composition entry. A settings
     * service attached within the window starts on the stored directory; the
     * deferred fallback then finds the same directory and is a no-op. Never
     * user-facing — a test-only tilt at the boot deferral. */
    startupDeferMs?: number;
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
 * The settings-facing subset of the config: the data directory and the mirror
 * region pick. `pricingUrlDomestic` / `pricingUrlOverseas` stay
 * composition-entry keys — the plugin still honors them from cordis.yml for
 * self-maintained forks, but a user-facing card should not restate raw feed
 * URLs. A descriptive line about this section lives in the card's copy, not
 * in the document.
 */
export interface SectionConfig {
    /** Data directory; resolved through `resolveDataDir` when absent. */
    path?: string;
    /** Mirror to pull when no explicit `pricingUrl` is set: `domestic` (default) or `overseas`. */
    pricingRegion?: 'domestic' | 'overseas';
}
/** Schema resolving the `token-usage` settings section. */
export declare const sectionSchema: z<SectionConfig>;
/**
 * Reject an empty stored path: the schema cannot (an empty string is a valid
 * string), and it would silently disable the explicit-directory intent.
 * @param value - the resolved section, schema-valid by construction.
 */
export declare function validateSection(value: SectionConfig): void;
/** Live facts a section write is vetted against. */
export interface SectionGuard {
    /** Directory currently in force; undefined before the first start. */
    runningDir: string | undefined;
    /** Sessions mid-conversation (an open turn) at validation time. */
    interactingSessions: number;
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
export declare function countInteractingSessions(sessions: readonly {
    events: readonly {
        type: string;
    }[];
}[]): number;
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
export declare function directoryGuard(proposed: string | undefined, guard: SectionGuard): DirectoryGuardView;
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
export declare function validateSectionChange(value: SectionConfig, guard: SectionGuard): void;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map