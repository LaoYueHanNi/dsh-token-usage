/**
 * One-shot initialization marker: whether the plugin ever completed a history
 * sync. The marker exists only to gate the FIRST automatic sync; every later
 * sync is the user's decision (the manual command).
 *
 * @module token-usage/sync-state
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const STATE_FILE = 'state.json';
const TMP_FILE = 'state.json.tmp';
function isSyncState(value) {
    return typeof value === 'object' && value !== null
        && typeof value.initializedAt === 'number'
        && Number.isFinite(value.initializedAt);
}
/**
 * Whether the first automatic sync already completed. A missing or malformed
 * marker reads as uninitialized: the next startup re-runs the sync, whose
 * dedupe makes the repetition a no-op.
 * @param dir - the data directory holding the marker.
 */
export async function isInitialized(dir) {
    let text;
    try {
        text = await readFile(join(dir, STATE_FILE), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        console.error('[token-usage] cannot read state:', error);
        return false;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        // Malformed marker: treat as uninitialized (the sync re-runs idempotently).
        return false;
    }
    return isSyncState(value);
}
/**
 * Persist the initialized marker atomically (temp file + rename), so a crash
 * mid-write never leaves a torn marker that would misread as initialized.
 * @param dir - the data directory holding the marker.
 * @param now - clock source (test seam).
 */
export async function markInitialized(dir, now = () => new Date()) {
    const target = join(dir, STATE_FILE);
    const tmp = join(dir, TMP_FILE);
    await writeFile(tmp, JSON.stringify({ initializedAt: now().getTime() }), 'utf8');
    await rename(tmp, target);
}
//# sourceMappingURL=sync-state.js.map