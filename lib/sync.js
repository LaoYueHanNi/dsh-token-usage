/**
 * History sync: replay every persisted session log and append the request
 * rows the log does not already hold, deduped by request id. The sync runs
 * automatically ONCE, on the first startup after installation (gated by the
 * initialized marker).
 *
 * @module token-usage/sync
 */
import { isInitialized, markInitialized } from "./sync-state.js";
import { recordFromEvent } from "./usage-record.js";
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
export async function syncHistory(deps, onTick, signal) {
    await deps.log.scan();
    const sessions = await deps.persistence.list(signal === undefined ? undefined : { signal });
    let added = 0;
    let skipped = 0;
    const total = sessions.length;
    let processed = 0;
    onTick?.({ processed, total, added, skipped });
    for (const session of sessions) {
        signal?.throwIfAborted();
        const options = signal === undefined ? undefined : { signal };
        const handle = await deps.persistence.open(session.header.id, 'read', options);
        let events;
        try {
            events = await handle.read(0, undefined, options);
        }
        catch (error) {
            // The read failure is the actionable cause; a close failure on the same
            // broken handle adds nothing.
            try {
                await handle.close();
            }
            catch { /* see above */ }
            throw error;
        }
        await handle.close();
        for (const event of events) {
            signal?.throwIfAborted();
            if (event.type !== 'assistant/message')
                continue;
            const record = recordFromEvent(event, session.header.id);
            if (await deps.log.record(record))
                added += 1;
            else
                skipped += 1;
        }
        processed += 1;
        onTick?.({ processed, total, added, skipped });
    }
    return { added, skipped };
}
/**
 * Run the one-shot automatic sync when the initialized marker is absent, then
 * persist the marker. A crash between the sync and the marker write leaves
 * the marker absent, so the next startup re-runs the sync — a no-op thanks to
 * dedupe.
 * @param deps - persistence and the shared log.
 * @param dir - the data directory holding the marker.
 * @returns the sync outcome, or null when the marker was already present.
 */
export async function autoSyncIfNeeded(deps, dir) {
    if (await isInitialized(dir))
        return null;
    const result = await syncHistory(deps);
    await markInitialized(dir);
    return result;
}
//# sourceMappingURL=sync.js.map