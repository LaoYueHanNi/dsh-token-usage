/**
 * History sync: replay every persisted session log and append the request
 * rows the log does not already hold, deduped by request id. The sync runs
 * automatically ONCE, on the first startup after installation (gated by the
 * initialized marker).
 *
 * @module token-usage/sync
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { UsageLog } from './usage-log.ts';
/** Outcome of one sync run. */
export interface SyncResult {
    /** Rows appended to the log. */
    added: number;
    /** Requests already present in the log (deduped). */
    skipped: number;
}
/**
 * One progress tick of a long sync: the host forwards these to the card so the
 * user can see how far the manual scan has gotten. The first tick is emitted
 * before the first session is read (so the bar shows `0/total` immediately),
 * and one tick follows each completed session. `total` is the session count
 * seen at the start of the run; a session that appears mid-run does not
 * change it.
 */
export interface SyncProgressTick {
    /** Sessions fully processed so far. */
    processed: number;
    /** Total sessions this run intends to walk (frozen at the start). */
    total: number;
    /** Rows appended to the log so far. */
    added: number;
    /** Rows skipped by dedupe so far. */
    skipped: number;
}
/** The persistence surface the sync needs (duck-typed for tests). */
export interface SyncPersistence {
    /** Every materialized session, in arbitrary order. */
    list(signal?: AbortSignal): Promise<{
        id: SessionId;
    }[]>;
    /** Immutable logical event log of one session. */
    inspect(id: SessionId, signal?: AbortSignal): Promise<{
        events: readonly SessionEvent[];
    }>;
}
/** Dependencies of one sync run. */
export interface SyncDeps {
    persistence: SyncPersistence;
    log: UsageLog;
}
/**
 * Append every missing request row. The log's dedupe set is rebuilt from the
 * data files first, so a second run is a no-op and rows recorded live in a
 * previous process are not duplicated.
 * @param deps - persistence and the shared log.
 * @param onTick - optional progress callback; fires once before the first
 * session (with `processed: 0` and the final `total`), then once per session
 * as it finishes. The card passes this to drive its progress bar; the
 * one-shot startup sync omits it.
 * @param signal - cancellation; an aborted run throws `AbortError`.
 */
export declare function syncHistory(deps: SyncDeps, onTick?: (tick: SyncProgressTick) => void, signal?: AbortSignal): Promise<SyncResult>;
/**
 * Run the one-shot automatic sync when the initialized marker is absent, then
 * persist the marker. A crash between the sync and the marker write leaves
 * the marker absent, so the next startup re-runs the sync — a no-op thanks to
 * dedupe.
 * @param deps - persistence and the shared log.
 * @param dir - the data directory holding the marker.
 * @returns the sync outcome, or null when the marker was already present.
 */
export declare function autoSyncIfNeeded(deps: SyncDeps, dir: string): Promise<SyncResult | null>;
//# sourceMappingURL=sync.d.ts.map