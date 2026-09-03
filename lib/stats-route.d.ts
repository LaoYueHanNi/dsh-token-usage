/**
 * The stats HTTP route of the token-usage plugin: a webServer exact route
 * serving the JSON summary at `/token-usage/stats` for the web settings page.
 * The /api prefix is owned by the browser-transport connection plugin and its
 * RPC method table is closed, so the plugin data channel is its own route.
 *
 * @module token-usage/stats-route
 */
import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { MigrationProgress } from './migrate.ts';
import { type LoggerLike } from './log.ts';
import type { DirectoryGuardView, DisplayCurrency, FullSyncView } from './wire.ts';
/** The stats endpoint path, exported for tests and the client half. */
export { STATS_PATH } from './wire.ts';
/** The migration-progress endpoint path, exported for the client half. */
export { MIGRATION_PATH } from './wire.ts';
/** The directory-guard endpoint path, exported for the client half. */
export { DIR_GUARD_PATH } from './wire.ts';
/** The full-sync endpoint path, exported for the client half. */
export { FULL_SYNC_PATH } from './wire.ts';
/**
 * Whether a request may read the stats: same-origin browser fetches only.
 * Browsers send `Sec-Fetch-Site` on cross-origin requests; a cross-site value
 * (or a cross-site GET from a page on another origin) is refused. The header
 * is absent for non-browser clients (curl, tests), which are allowed.
 * @param req - the incoming request.
 * @returns whether the request originates from the served page.
 */
export declare function isSameOriginFetch(req: IncomingMessage): boolean;
/** How the route resolves the display currency per request; a thunk so a
 * live settings change (the region pick) lands without rebuilding the route. */
export interface StatsRouteOptions {
    currency?: () => DisplayCurrency;
    /** Diagnostic sink for data reads; defaults to console. */
    logger?: LoggerLike;
}
/** Live progress of a data-directory relocation; undefined when none runs. */
export type MigrationStatus = MigrationProgress | undefined;
/**
 * Build the migration-progress route the browser card polls while a move
 * runs. Read-only by construction: it answers the shared status object and
 * nothing else.
 * @param status - reads the live migration state.
 * @returns the exact GET route answering the progress JSON.
 */
export declare function createMigrationRoute(status: () => MigrationStatus): WebRoute;
/**
 * Build the directory-guard route the browser card consults before saving a
 * staged directory edit: the settings wire never delivers a refused write's
 * reason, so the card asks here whether the save would be refused and shows
 * the verdict's count itself. Read-only by construction: it answers the
 * caller's judge verdict and writes nothing.
 * @param judge - answers the verdict for one proposed stored path
 * (`undefined` when the save would clear the override).
 * @returns the exact GET route answering the verdict JSON.
 */
export declare function createDirectoryGuardRoute(judge: (proposed: string | undefined) => DirectoryGuardView): WebRoute;
/**
 * Outcome of one manual full-sync trigger.
 * - `started: true` — the run kicked off; the next poll will see the live counts.
 * - `started: false, reason: 'already-running'` — a run is still in flight;
 *   the card surfaces this as the button's disabled state and a 409 response.
 */
export type FullSyncTrigger = {
    started: true;
} | {
    started: false;
    reason: 'already-running';
};
/**
 * Build the full-sync route backing the card's manual "scan again" button.
 * The handler is small by design: it only owns the request/response shape
 * (GET polls the live status, POST kicks off a run). The actual scan lives
 * on the host half and updates the shared status object, which `status()`
 * reads. The scan is fire-and-forget on POST so the request never blocks
 * behind a long walk; the card polls until the status leaves `running`.
 * @param status - reads the shared status (the same view the card renders).
 * @param trigger - kicks off a new run when the host is idle.
 * @returns the exact route serving both methods.
 */
export declare function createFullSyncRoute(status: () => FullSyncView, trigger: () => FullSyncTrigger): WebRoute;
/**
 * Build the stats route over a data directory the caller may relocate live.
 * @param dir - reads the directory currently in force (per request, so a
 * settings-driven move starts answering from the new location at once).
 * @param options - the currency thunk; defaults to CNY (the domestic default).
 * @returns the exact GET route serving the JSON summary.
 */
export declare function createStatsRoute(dir: () => string, options?: StatsRouteOptions): WebRoute;
//# sourceMappingURL=stats-route.d.ts.map