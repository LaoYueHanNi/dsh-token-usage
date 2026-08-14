/**
 * Stats computation of the token-usage plugin: read every day file and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window. Pure aggregation lives apart from the file walk so the web route
 * and tests share one implementation.
 *
 * @module token-usage/stats
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRecord } from "./usage-record.js";
const DAY_FILE = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/u;
/** Bounded recent window length: only the newest records cross the wire. */
export const RECENT_LIMIT = 20;
/** Zeroed totals; requests counts rows, the token buckets sum reported usage. */
export function emptyTotals() {
    return {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
}
/** Fold one record into totals; a record without provider usage still counts a request. */
function addUsage(totals, usage) {
    totals.requests += 1;
    if (usage === undefined)
        return;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens !== undefined)
        totals.cacheReadTokens += usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined)
        totals.cacheWriteTokens += usage.cacheWriteTokens;
}
/** Local date key of a record time, matching the day-file naming convention. */
function dayKey(time) {
    const date = new Date(time);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/**
 * Fold records into the summary shape. The recent window keeps the last
 * {@link RECENT_LIMIT} records in input order (day files are chronological)
 * and then sorts them by time descending.
 * @param records - parsed records in day-file order.
 * @returns totals, day rows, model rows, and the recent window.
 */
export function summarizeRecords(records) {
    const total = emptyTotals();
    const days = new Map();
    const models = new Map();
    const recent = [];
    for (const record of records) {
        addUsage(total, record.usage);
        const day = days.get(dayKey(record.time)) ?? emptyTotals();
        addUsage(day, record.usage);
        days.set(dayKey(record.time), day);
        const model = models.get(record.model) ?? emptyTotals();
        addUsage(model, record.usage);
        models.set(record.model, model);
        if (recent.length === RECENT_LIMIT)
            recent.shift();
        recent.push(record);
    }
    const byDay = [...days.entries()]
        .map(([day, totals]) => ({ day, totals }))
        .sort((left, right) => left.day < right.day ? -1 : 1);
    const byModel = [...models.entries()]
        .map(([model, totals]) => ({ model, totals }))
        .sort((left, right) => right.totals.requests - left.totals.requests || left.model.localeCompare(right.model));
    recent.sort((left, right) => right.time - left.time);
    return { total, byDay, byModel, recent };
}
/**
 * Read every day file into records, in day-file order. Malformed lines are
 * skipped silently — unlike the sync scan's dedupe pass, the stats read runs
 * on every page refresh and must not spam the console over one bad row.
 * An absent data directory (nothing written yet) yields an empty list.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */
export async function readAllRecords(dir) {
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    names.sort();
    const records = [];
    for (const name of names) {
        if (!DAY_FILE.test(name))
            continue;
        const text = await readFile(join(dir, name), 'utf8').catch((error) => {
            console.error(`[token-usage] cannot read ${name}:`, error);
            return '';
        });
        for (const line of text.split('\n')) {
            if (line === '')
                continue;
            const record = parseRecord(line);
            if (record !== null)
                records.push(record);
        }
    }
    return records;
}
/**
 * Build the full stats payload for one data directory.
 * @param dir - the plugin's data directory.
 * @returns the summary served to the web settings page.
 */
export async function buildSummary(dir) {
    return { dataDir: dir, ...summarizeRecords(await readAllRecords(dir)) };
}
//# sourceMappingURL=stats.js.map