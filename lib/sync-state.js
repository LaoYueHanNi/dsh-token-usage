/**
 * Per-session sync progress: the seq watermark of every session already folded
 * into the durable log. Read at startup so each session's first sync on a
 * machine only walks the suffix past the watermark; writes back atomically
 * (temp + rename) so a crash mid-write leaves either the old or the new
 * progress, never a torn watermark that would double-record the next run.
 *
 * v1 (`{"initializedAt": number}`) is recognized for backward compatibility
 * and treated as an empty progress map: the first run after the upgrade
 * performs one full sync, then persists the new shape.
 *
 * @module token-usage/sync-state
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const STATE_FILE = 'state.json';
const TMP_FILE = 'state.json.tmp';
function isSessionProgress(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    const seq = record.lastSyncedSeq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0)
        return false;
    // Optional: when present it must be a string; absent means "no observation"
    // (records predating this field) and forces one full sync on the next run.
    if (record.lastSeenRevision !== undefined && typeof record.lastSeenRevision !== 'string')
        return false;
    return true;
}
function isV2(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const root = value;
    if (root.version !== 2)
        return false;
    if (root.syncedAt !== undefined
        && (typeof root.syncedAt !== 'number' || !Number.isFinite(root.syncedAt)))
        return false;
    if (typeof root.sessions !== 'object' || root.sessions === null)
        return false;
    const sessions = root.sessions;
    for (const key of Object.keys(sessions)) {
        if (!isSessionProgress(sessions[key]))
            return false;
    }
    return true;
}
function isV1Initialized(value) {
    return typeof value === 'object' && value !== null
        && typeof value.initializedAt === 'number'
        && Number.isFinite(value.initializedAt);
}
/**
 * Read the sync progress. A missing, malformed, or v1-only file reads as an
 * empty v2 progress map: the first run after a missing/v1 marker performs one
 * full sync, then persists the v2 shape. v2 corruption reads as empty so a
 * crash mid-write cannot strand the user on a half-finished watermark.
 * @param dir - the data directory holding the marker.
 */
export async function readSyncProgress(dir) {
    let text;
    try {
        text = await readFile(join(dir, STATE_FILE), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return emptyProgress();
        console.error('[token-usage] cannot read state:', error);
        return emptyProgress();
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return emptyProgress();
    }
    if (isV2(value))
        return value;
    if (isV1Initialized(value))
        return emptyProgress();
    return emptyProgress();
}
function emptyProgress() {
    return { version: 2, sessions: {} };
}
/**
 * Persist the sync progress atomically (temp file + rename), so a crash
 * mid-write never leaves a torn watermark that would double-record the next
 * run. Absent optional fields are omitted under `exactOptionalPropertyTypes`.
 * @param dir - the data directory holding the marker.
 * @param progress - the progress to persist.
 */
export async function writeSyncProgress(dir, progress) {
    const target = join(dir, STATE_FILE);
    const tmp = join(dir, TMP_FILE);
    // Mirror the on-disk shape into a plain object so `JSON.stringify` skips
    // `undefined` `lastSeenRevision` rather than writing the key with no value
    // (which would later fail `isV2` because the key is present but undefined).
    const sessions = {};
    for (const [id, entry] of Object.entries(progress.sessions)) {
        const row = { lastSyncedSeq: entry.lastSyncedSeq };
        if (entry.lastSeenRevision !== undefined)
            row.lastSeenRevision = entry.lastSeenRevision;
        sessions[id] = row;
    }
    const payload = { version: 2, sessions };
    if (progress.syncedAt !== undefined)
        payload.syncedAt = progress.syncedAt;
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, target);
}
//# sourceMappingURL=sync-state.js.map