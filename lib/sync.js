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
import { readSyncProgress, writeSyncProgress } from "./sync-state.js";
import { recordFromEvent } from "./usage-record.js";
/**
 * Append every missing request row, walking each session's stored events from
 * the persisted watermark (`lastSyncedSeq + 1`) onward. The log's dedupe set
 * is rebuilt from the data files first, so rows recorded live in a previous
 * process are not duplicated even if their watermark is missing.
 *
 * @param deps - persistence and the shared log.
 * @param signal - cancellation; an aborted run throws `AbortError`.
 */
export async function syncHistory(deps, signal) {
    await deps.log.scan();
    const sessions = await deps.persistence.list(signal);
    let added = 0;
    let skipped = 0;
    for (const header of sessions) {
        signal?.throwIfAborted();
        const inspection = await deps.persistence.readFrom(header.id, 0, signal);
        for (const event of inspection.events) {
            signal?.throwIfAborted();
            if (event.type !== 'assistant/message')
                continue;
            const record = recordFromEvent(event, header.id);
            if (await deps.log.record(record))
                added += 1;
            else
                skipped += 1;
        }
    }
    return { added, skipped };
}
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
export async function autoSyncIfNeeded(deps, dir, signal) {
    await deps.log.scan();
    const progress = await readSyncProgress(dir);
    const sessions = await deps.persistence.list(signal);
    let added = 0;
    let skipped = 0;
    for (const header of sessions) {
        signal?.throwIfAborted();
        const lastSynced = progress.sessions[header.id]?.lastSyncedSeq ?? -1;
        const fromSeq = lastSynced + 1;
        const { events } = await deps.persistence.readFrom(header.id, fromSeq, signal);
        let maxSeq = lastSynced;
        for (const event of events) {
            signal?.throwIfAborted();
            if (event.seq > maxSeq)
                maxSeq = event.seq;
            if (event.type !== 'assistant/message')
                continue;
            const record = recordFromEvent(event, header.id);
            if (await deps.log.record(record))
                added += 1;
            else
                skipped += 1;
        }
        progress.sessions[header.id] = { lastSyncedSeq: maxSeq };
    }
    const stamped = { version: 2, ...(added > 0 ? { syncedAt: Date.now() } : {}), sessions: progress.sessions };
    await writeSyncProgress(dir, stamped);
    if (sessions.length === 0 && added === 0)
        return null;
    return { added, skipped };
}
//# sourceMappingURL=sync.js.map