/**
 * Stats computation of the token-usage plugin: read the day files and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window. Frozen (pre-today) day files are served from the on-disk rollup
 * (see rollup.ts); only today's file is read on every call. Pure aggregation
 * lives apart from the file walk so the web route and tests share one
 * implementation.
 *
 * @module token-usage/stats
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRecord } from "./usage-record.js";
import { readRollup, writeRollup } from "./rollup.js";
const DAY_FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/u;
/** Bounded recent window length: only the newest records cross the wire. */
export const RECENT_LIMIT = 20;
/** The date part of a day-file name, or null for a foreign name. */
function fileDay(name) {
    return DAY_FILE.exec(name)?.[1] ?? null;
}
/** Empty rollup used as the merge base when no rollup exists on disk yet. */
function emptyRollup() {
    return { upto: '', total: emptyTotals(), byDay: [], byModel: [], recent: [] };
}
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
/** Add one totals row into another, field by field. */
function addTotals(target, source) {
    target.requests += source.requests;
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheReadTokens += source.cacheReadTokens;
    target.cacheWriteTokens += source.cacheWriteTokens;
}
/** Sort a day row map ascending by day, matching {@link summarizeRecords}. */
function dayRows(days) {
    return [...days.entries()]
        .map(([day, totals]) => ({ day, totals }))
        .sort((left, right) => left.day < right.day ? -1 : 1);
}
/** Sort a model row map by requests descending then model name, matching {@link summarizeRecords}. */
function modelRows(models) {
    return [...models.entries()]
        .map(([model, totals]) => ({ model, totals }))
        .sort((left, right) => right.totals.requests - left.totals.requests || left.model.localeCompare(right.model));
}
/**
 * Fold one record into totals; a record without provider usage still counts a request. */
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
    const byDay = dayRows(days);
    const byModel = modelRows(models);
    recent.sort((left, right) => right.time - left.time);
    return { total, byDay, byModel, recent };
}
/**
 * Merge two summaries into one: totals and model rows add up, day rows fold
 * by day key (a same-day record set landing in a later file must join the
 * earlier bucket, never replace it), and the recent window keeps the newest
 * {@link RECENT_LIMIT} records across both sides. Order-independent and
 * associative: merging partial summaries equals summarizing the concatenated
 * records.
 * @param left - one partial summary.
 * @param right - the other partial summary.
 * @returns the folded summary.
 */
export function mergeSummaries(left, right) {
    const total = emptyTotals();
    addTotals(total, left.total);
    addTotals(total, right.total);
    const days = new Map();
    const models = new Map();
    for (const row of [...left.byDay, ...right.byDay]) {
        const day = days.get(row.day) ?? emptyTotals();
        addTotals(day, row.totals);
        days.set(row.day, day);
    }
    for (const row of [...left.byModel, ...right.byModel]) {
        const model = models.get(row.model) ?? emptyTotals();
        addTotals(model, row.totals);
        models.set(row.model, model);
    }
    const recent = [...left.recent, ...right.recent]
        .sort((a, b) => b.time - a.time)
        .slice(0, RECENT_LIMIT);
    return { total, byDay: dayRows(days), byModel: modelRows(models), recent };
}
/**
 * Read one day file into records. Malformed lines are skipped silently —
 * unlike the sync scan's dedupe pass, the stats read runs on every page
 * refresh and must not spam the console over one bad row. An unreadable
 * file logs once and reads as empty, so a corrupt log never blocks stats.
 * @param dir - the plugin's data directory.
 * @param name - the day-file name.
 */
async function readDayFile(dir, name) {
    const text = await readFile(join(dir, name), 'utf8').catch((error) => {
        console.error(`[token-usage] cannot read ${name}:`, error);
        return '';
    });
    const records = [];
    for (const line of text.split('\n')) {
        if (line === '')
            continue;
        const record = parseRecord(line);
        if (record !== null)
            records.push(record);
    }
    return records;
}
/** List the data directory's day-file names in ascending date order ([] when absent). */
async function listDayFiles(dir) {
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    return names.filter(name => fileDay(name) !== null).sort();
}
/**
 * Read every day file into records, in day-file order. An absent data
 * directory (nothing written yet) yields an empty list.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */
export async function readAllRecords(dir) {
    const records = [];
    for (const name of await listDayFiles(dir)) {
        records.push(...await readDayFile(dir, name));
    }
    return records;
}
/**
 * Build the full stats payload for one data directory: the rollup over every
 * frozen day file (advanced lazily and rewritten atomically when unabsorbed
 * frozen files appear) merged with a fresh read of today's file. Day files
 * named at or after today but already absorbed by a later rollup `upto` are
 * skipped, so a clock stepping back cannot count an absorbed file twice.
 * A failed rollup write logs and does not block the response — the next read
 * retries the absorption.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @returns the summary served to the web settings page.
 */
export async function buildSummary(dir, now = () => new Date()) {
    const today = dayKey(now().getTime());
    const rollup = (await readRollup(dir)) ?? emptyRollup();
    const cold = [];
    const hot = [];
    for (const name of await listDayFiles(dir)) {
        const day = fileDay(name);
        if (day <= rollup.upto)
            continue;
        if (day < today)
            cold.push(name);
        else
            hot.push(name);
    }
    let absorbed = rollup;
    if (cold.length > 0) {
        // names are date-ascending, so the last cold file carries the new upto
        const records = [];
        for (const name of cold)
            records.push(...await readDayFile(dir, name));
        absorbed = {
            upto: fileDay(cold[cold.length - 1]),
            ...mergeSummaries(rollup, summarizeRecords(records)),
        };
        await writeRollup(dir, absorbed).catch((error) => {
            console.error('[token-usage] cannot write rollup:', error);
        });
    }
    const fresh = [];
    for (const name of hot)
        fresh.push(...await readDayFile(dir, name));
    return { dataDir: dir, ...mergeSummaries(absorbed, summarizeRecords(fresh)) };
}
//# sourceMappingURL=stats.js.map