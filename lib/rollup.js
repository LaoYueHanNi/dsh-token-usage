/**
 * The per-day rollup store of the token-usage plugin: an on-disk aggregate of
 * every frozen (pre-today) day file. Day files are immutable once their date
 * has passed — writes always append to the file of the current day — so an
 * absorbed aggregate never goes stale and needs no invalidation. The stats
 * read advances the rollup lazily: whenever unabsorbed frozen files exist,
 * they are folded in and the rollup is rewritten atomically (temp file +
 * rename, like the sync marker). A missing or malformed rollup simply reads
 * as absent and is rebuilt from the day files.
 *
 * @module token-usage/rollup
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coerceRecord } from "./usage-record.js";
const ROLLUP_FILE = 'rollup.json';
const TMP_FILE = 'rollup.json.tmp';
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;
function isTotals(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const totals = value;
    return ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .every(key => typeof totals[key] === 'number' && Number.isFinite(totals[key]));
}
function isDayRow(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const row = value;
    return typeof row.day === 'string' && DAY_KEY.test(row.day) && isTotals(row.totals);
}
function isModelRow(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const row = value;
    return typeof row.model === 'string' && isTotals(row.totals);
}
function isRollupFile(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const rollup = value;
    return typeof rollup.upto === 'string' && DAY_KEY.test(rollup.upto)
        && isTotals(rollup.total)
        && Array.isArray(rollup.byDay) && rollup.byDay.every(isDayRow)
        && Array.isArray(rollup.byModel) && rollup.byModel.every(isModelRow)
        && Array.isArray(rollup.recent);
}
/**
 * Load the rollup of one data directory. A missing, malformed, or
 * structurally invalid rollup reads as null — the caller then rebuilds it
 * from the day files, so corruption never blocks the stats read. Invalid
 * entries inside the recent window are dropped instead of failing the whole
 * rollup, mirroring how malformed JSONL lines are skipped.
 * @param dir - the plugin's data directory.
 */
export async function readRollup(dir) {
    let text;
    try {
        text = await readFile(join(dir, ROLLUP_FILE), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        console.error('[token-usage] cannot read rollup:', error);
        return null;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        // A torn or hand-edited rollup rebuilds from the day files.
        return null;
    }
    if (!isRollupFile(value))
        return null;
    const recent = value.recent
        .map(coerceRecord)
        .filter((record) => record !== null);
    return { ...value, recent };
}
/**
 * Persist the rollup atomically (temp file + rename), so a crash mid-write
 * leaves either the old or the new rollup, never a torn one.
 * @param dir - the plugin's data directory.
 * @param rollup - the rollup to persist.
 */
export async function writeRollup(dir, rollup) {
    const target = join(dir, ROLLUP_FILE);
    const tmp = join(dir, TMP_FILE);
    await writeFile(tmp, JSON.stringify(rollup), 'utf8');
    await rename(tmp, target);
}
//# sourceMappingURL=rollup.js.map