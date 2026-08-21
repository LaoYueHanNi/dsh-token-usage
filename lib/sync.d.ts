/**
 * History sync: replay every persisted session log and append the request
 * rows the log does not already hold, deduped by request id. The sync runs on
 * every startup with a per-session seq watermark so it only walks the suffix
 * past the last successful sync. A re-install that does not go through
 * `remove` keeps the watermark and therefore the same suffix-only behavior;
 * a missing or v1-only marker forces one full sync, after which the new v2
 * watermark is persisted.
 *
 * @module token-usage/sync
 */
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { UsageLog } from './usage-log.ts';
/** Outcome of one sync run. */
export interface SyncResult {
    /** Rows appended to the log. */
    added: number;
    /** Requests already present in the log (deduped). */
    skipped: number;
}
/** One stored session paired with a backend-owned change token. */
export interface SessionSnapshot {
    header: SessionHeader;
    /**
     * Opaque revision token. Equal across observations of the unchanged log;
     * changes when the stored events change. Callers must treat it as
     * equality-only — its content is backend-internal.
     */
    revision: string;
}
/** The persistence surface the sync needs (duck-typed for tests). */
export interface SyncPersistence {
    /**
     * Lightweight listing with a per-session revision token. The token lets the
     * sync short-circuit unchanged sessions — `readFrom` on a JSONL backend
     * walks the entire file even when the requested suffix is empty, so
     * comparing revisions avoids that cost for the common no-event restart.
     */
    listSnapshots(signal?: AbortSignal): Promise<SessionSnapshot[]>;
    /**
     * Read the stored events from `fromSeq` onward — the suffix-only primitive
     * that powers watermark-based sync. Returns an empty event list when
     * `fromSeq` is at or past the stored prefix, never an error.
     */
    readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
        meta: SessionHeader;
        events: SessionEvent[];
    }>;
}
/** Dependencies of one sync run. */
export interface SyncDeps {
    persistence: SyncPersistence;
    log: UsageLog;
}
/**
 * Append every missing request row, walking each session's stored events from
 * the persisted watermark (`lastSyncedSeq + 1`) onward. The log's dedupe set
 * is rebuilt from the data files first, so rows recorded live in a previous
 * process are not duplicated even if their watermark is missing.
 *
 * @param deps - persistence and the shared log.
 * @param signal - cancellation; an aborted run throws `AbortError`.
 */
export declare function syncHistory(deps: SyncDeps, signal?: AbortSignal): Promise<SyncResult>;
/**
 * Fold every persisted session's unsynced suffix into the log and persist the
 * per-session watermark map. Runs on every startup so a re-install that did
 * not go through `remove` still catches the events that fell into the
 * restart window (when the live hook was not yet attached). The first run on
 * a machine — or the first run after a missing/v1 marker — does a full sync
 * (watermark `0` for every session); later runs only walk past the watermark.
 *
 * @param deps - persistence and the shared log.
 * @param dir - the data directory holding the watermark.
 * @param signal - cancellation; an aborted run throws `AbortError`.
 * @returns the sync outcome, or null when nothing was scanned (no sessions).
 */
export declare function autoSyncIfNeeded(deps: SyncDeps, dir: string, signal?: AbortSignal): Promise<SyncResult | null>;
//# sourceMappingURL=sync.d.ts.map