/**
 * Stats computation of the token-usage plugin: read the day files and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window — keeping one row per (day, model, rate identity) so every record
 * is billed at the rate its own timestamp resolved through (see
 * pricing.resolveRate). Frozen (pre-today) day files are served from the
 * on-disk rollup (see rollup.ts); only today's file is read on every call.
 * Pure aggregation lives apart from the file walk so the web route and tests
 * share one implementation.
 *
 * @module token-usage/stats
 */
import { costOf, ratesForKey } from "./pricing.js";
import { fileDay, listDayFiles, readDayFile } from "./record-cache.js";
import { consoleLogger } from "./log.js";
import { readRollup, writeRollup } from "./rollup.js";
import { UNPRICED_KEY } from "./wire.js";
/** Bounded recent window length: only the newest records cross the wire. */
export const RECENT_LIMIT = 20;
/** Empty rollup used as the merge base when no rollup exists on disk yet. */
function emptyRollup() {
    return { upto: '', total: emptyTotals(), byDay: [], byHour: [], byModel: [], rateRows: [], recent: [] };
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
/** Deterministic rate-identity order: rule window, tier, slot. */
function compareKeys(left, right) {
    return left.ruleStart - right.ruleStart || left.ruleEnd - right.ruleEnd
        || left.tier - right.tier || left.slot - right.slot;
}
/** Sort rate rows day ascending, then model name, then rate identity. */
function rateRowsSorted(rows) {
    return [...rows].sort((left, right) => left.day < right.day ? -1 : left.day > right.day ? 1
        : left.model < right.model ? -1 : left.model > right.model ? 1
            : compareKeys(left.rate, right.rate));
}
/** Map key of one (day, model, rate) cell. */
function rateRowKey(day, model, rate) {
    return `${day}\n${model}\n${rate.ruleStart}-${rate.ruleEnd}-${rate.tier}-${rate.slot}`;
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
/** Local `YYYY-MM-DDTHH` key of a record time, the byHour row key. */
function hourKey(time) {
    const date = new Date(time);
    const hour = String(date.getHours()).padStart(2, '0');
    return `${dayKey(time)}T${hour}`;
}
/** Map key of one (hour, model) cell. */
function hourRowKey(hour, model) {
    return `${hour}\n${model}`;
}
/** Sort an hour row map by hour ascending then model name, matching {@link summarizeRecords}. */
function hourRows(hours) {
    return [...hours.entries()]
        .map(([key, totals]) => {
        const separator = key.indexOf('\n');
        return { hour: key.slice(0, separator), model: key.slice(separator + 1), totals };
    })
        .sort((left, right) => left.hour < right.hour ? -1 : left.hour > right.hour ? 1
        : left.model < right.model ? -1 : left.model > right.model ? 1
            : 0);
}
/**
 * Fold records into the token summary shape, one rate row per (day, model,
 * rate identity) the resolver assigns. The recent window keeps the last
 * {@link RECENT_LIMIT} records in input order (day files are chronological)
 * and then sorts them by time descending.
 * @param records - parsed records in day-file order.
 * @param resolve - the rate resolver; defaults to leaving every record unpriced.
 * @returns totals, day rows, model rows, rate rows, and the recent window.
 */
export function summarizeRecords(records, resolve = () => UNPRICED_KEY) {
    const total = emptyTotals();
    const days = new Map();
    const hours = new Map();
    const models = new Map();
    const rated = new Map();
    const recent = [];
    for (const record of records) {
        addUsage(total, record.usage);
        const day = dayKey(record.time);
        const dayTotals = days.get(day) ?? emptyTotals();
        addUsage(dayTotals, record.usage);
        days.set(day, dayTotals);
        const hour = hourKey(record.time);
        const hourTotals = hours.get(hourRowKey(hour, record.model)) ?? emptyTotals();
        addUsage(hourTotals, record.usage);
        hours.set(hourRowKey(hour, record.model), hourTotals);
        const modelTotals = models.get(record.model) ?? emptyTotals();
        addUsage(modelTotals, record.usage);
        models.set(record.model, modelTotals);
        const rate = resolve(record);
        const rowKey = rateRowKey(day, record.model, rate);
        const cell = rated.get(rowKey)
            ?? { day, model: record.model, rate, totals: emptyTotals() };
        addUsage(cell.totals, record.usage);
        rated.set(rowKey, cell);
        if (recent.length === RECENT_LIMIT)
            recent.shift();
        recent.push(record);
    }
    const byDay = dayRows(days);
    const byHour = hourRows(hours);
    const byModel = modelRows(models);
    recent.sort((left, right) => right.time - left.time);
    return { total, byDay, byHour, byModel, rateRows: rateRowsSorted(rated.values()), recent };
}
/**
 * Keep only the records owned by one of the listed sessions. The rollup
 * carries no session dimension (its rows are (day, model, rate) cells), so a
 * session-scoped read cannot reuse it and must fold the filtered raw records
 * instead — cheap in practice (the JSONL day files are a few hundred KB) and
 * only triggered by per-session fetches (view switches), never the settings
 * page's whole-log read.
 * @param records - parsed records in day-file order.
 * @param sessionIds - the sessions whose requests stay; [] yields no records.
 * @returns the records owned by those sessions, in the original order.
 */
export function filterRecordsBySessions(records, sessionIds) {
    const wanted = new Set(sessionIds);
    return records.filter(record => wanted.has(record.sessionId));
}
/**
 * Derive the half-open day-range bounds from optional `YYYY-MM-DD` keys. A
 * missing key leaves that side unbounded; the upper bound inherits the day's
 * full millisecond span (the day-key convention used everywhere else).
 * @param from - first day key (`YYYY-MM-DD`), inclusive; '' ignores both ends.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id; undefined matches any model.
 * @returns the bounds (every field may be undefined).
 */
export function dayRangeFilter(from, to, model) {
    const filter = {};
    if (from !== undefined && from !== '')
        filter.start = dayStart(from);
    if (to !== undefined && to !== '')
        filter.end = dayStart(to) + 86_399_999;
    if (model !== undefined && model !== '')
        filter.model = model;
    return filter;
}
/**
 * Combine a day-range filter with a session-id filter. The session ids are
 * applied first (cheap, preroll), the day-range second (per-record); the
 * model id, if any, is per-record too. Returns the records passing both.
 * @param records - parsed records in chronological order.
 * @param sessions - the session ids whose records stay; undefined skips that
 * dimension.
 * @param range - the day-range + model filter; undefined skips every dimension.
 */
export function filterRecordsByRange(records, sessions, range = {}) {
    const wanted = sessions !== undefined ? new Set(sessions) : undefined;
    const { start, end, model } = range;
    return records.filter(record => (wanted === undefined || wanted.has(record.sessionId))
        && (start === undefined || record.time >= start)
        && (end === undefined || record.time <= end)
        && (model === undefined || record.model === model));
}
/**
 * The per-request token series of a record set, in time order — one point
 * per request, so a 55-request session plots 55 points. The conversation
 * view tab draws this at request granularity; the settings page's hourly
 * aggregation is unchanged (this field is session-scope only).
 * @param records - the scoped records (day-file order is chronological).
 * @param from - optional inclusive day key; the series keeps those requests.
 * @param to - optional inclusive day key.
 * @param model - optional exact model id.
 * @returns one point per kept request, in the original time order.
 */
export function requestSeriesOf(records, from, to, model) {
    return filterRecordsByRange(records, undefined, dayRangeFilter(from, to, model))
        .map(record => ({
        time: record.time,
        tokens: record.usage === undefined ? 0
            : record.usage.inputTokens + record.usage.outputTokens
                + (record.usage.cacheReadTokens ?? 0) + (record.usage.cacheWriteTokens ?? 0),
    }));
}
/**
 * Merge two summaries into one: totals and model rows add up, day rows fold
 * by day key (a same-day record set landing in a later file must join the
 * earlier bucket, never replace it), rate rows fold by their (day, model,
 * rate) key, and the recent window keeps the newest {@link RECENT_LIMIT}
 * records across both sides. Order-independent and associative: merging
 * partial summaries equals summarizing the concatenated records.
 * @param left - one partial summary.
 * @param right - the other partial summary.
 * @returns the folded summary.
 */
export function mergeSummaries(left, right) {
    const total = emptyTotals();
    addTotals(total, left.total);
    addTotals(total, right.total);
    const days = new Map();
    const hours = new Map();
    const models = new Map();
    const rated = new Map();
    for (const row of [...left.byDay, ...right.byDay]) {
        const day = days.get(row.day) ?? emptyTotals();
        addTotals(day, row.totals);
        days.set(row.day, day);
    }
    for (const row of [...left.byHour, ...right.byHour]) {
        const key = hourRowKey(row.hour, row.model);
        const cell = hours.get(key) ?? emptyTotals();
        addTotals(cell, row.totals);
        hours.set(key, cell);
    }
    for (const row of [...left.byModel, ...right.byModel]) {
        const model = models.get(row.model) ?? emptyTotals();
        addTotals(model, row.totals);
        models.set(row.model, model);
    }
    for (const row of [...left.rateRows, ...right.rateRows]) {
        const key = rateRowKey(row.day, row.model, row.rate);
        const cell = rated.get(key)
            ?? { day: row.day, model: row.model, rate: row.rate, totals: emptyTotals() };
        addTotals(cell.totals, row.totals);
        rated.set(key, cell);
    }
    const recent = [...left.recent, ...right.recent]
        .sort((a, b) => b.time - a.time)
        .slice(0, RECENT_LIMIT);
    return {
        total,
        byDay: dayRows(days),
        byHour: hourRows(hours),
        byModel: modelRows(models),
        rateRows: rateRowsSorted(rated.values()),
        recent,
    };
}
/** Local-midnight epoch of a day key, matching the day-file convention. */
function dayStart(day) {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date).getTime();
}
/**
 * Re-aggregate a summary under an optional inclusive day range and model
 * filter, drawing every dimension from the rate rows so no file is reread.
 * The recent window filters on its record timestamps
 * ([from 00:00, to 23:59:59.999] local). No filters returns the input as-is.
 * @param summary - the unfiltered summary.
 * @param from - first day key (`YYYY-MM-DD`), inclusive.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id.
 * @returns the filtered summary.
 */
export function filterSummary(summary, from, to, model) {
    if (from === undefined && to === undefined && model === undefined)
        return summary;
    const rows = summary.rateRows.filter(row => (from === undefined || row.day >= from)
        && (to === undefined || row.day <= to)
        && (model === undefined || row.model === model));
    // Hour rows filter on their day prefix (the `YYYY-MM-DD` part of the key).
    const byHour = summary.byHour.filter(row => (from === undefined || row.hour.slice(0, 10) >= from)
        && (to === undefined || row.hour.slice(0, 10) <= to)
        && (model === undefined || row.model === model));
    const total = emptyTotals();
    const days = new Map();
    const models = new Map();
    for (const row of rows) {
        addTotals(total, row.totals);
        const day = days.get(row.day) ?? emptyTotals();
        addTotals(day, row.totals);
        days.set(row.day, day);
        const perModel = models.get(row.model) ?? emptyTotals();
        addTotals(perModel, row.totals);
        models.set(row.model, perModel);
    }
    const recent = filterRecordsByRange(summary.recent, undefined, dayRangeFilter(from, to, model));
    return { dataDir: summary.dataDir, total, byDay: dayRows(days), byHour, byModel: modelRows(models), rateRows: rateRowsSorted(rows), recent };
}
/**
 * Attach the cost layer to a token-only summary: each rate row is priced at
 * the prices its rate identity resolves to under the current table, folded
 * into per-model costs, the total, the unpriced model list, and the table
 * itself. Purely additive — totals, day rows, and the recent window are
 * returned untouched, so the token aggregation (and the rollup format)
 * never carries currency, and an updated table re-prices history for free.
 * @param summary - the aggregated summary (build or filtered).
 * @param pricing - the active pricing table.
 * @returns the same summary plus the cost fields.
 */
export function attachCosts(summary, pricing) {
    const costs = new Map();
    let totalCost = 0;
    for (const row of summary.rateRows) {
        const rules = pricing[row.model];
        if (rules === undefined)
            continue;
        const cost = costOf(row.totals, ratesForKey(rules, row.rate));
        costs.set(row.model, (costs.get(row.model) ?? 0) + cost);
        totalCost += cost;
    }
    const byModel = summary.byModel.map(row => ({
        model: row.model,
        totals: row.totals,
        cost: costs.get(row.model) ?? 0,
    }));
    const unpricedModels = summary.byModel
        .filter(row => pricing[row.model] === undefined)
        .map(row => row.model);
    return {
        dataDir: summary.dataDir,
        total: summary.total,
        totalCost,
        unpricedModels,
        pricing,
        byDay: summary.byDay,
        byHour: summary.byHour,
        byModel,
        rateRows: summary.rateRows,
        recent: summary.recent,
    };
}
/**
 * Read every day file into records, in day-file order. An absent data
 * directory (nothing written yet) yields an empty list. Uncached — the
 * session-scoped route uses `readCachedRecords` so repeated chip /
 * usage-tab polls do not re-parse frozen files.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */
export async function readAllRecords(dir, logger = consoleLogger) {
    const records = [];
    for (const name of await listDayFiles(dir)) {
        records.push(...await readDayFile(dir, name, logger));
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
 * retries the absorption. The resolver prices each record as it is absorbed,
 * so the rollup carries rate identities (never prices) and a table update
 * re-prices history without rebuilding anything.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @param resolve - the rate resolver (see {@link RateResolver}).
 * @returns the summary served to the web settings page.
 */
export async function buildSummary(dir, now = () => new Date(), resolve = () => UNPRICED_KEY, logger = consoleLogger) {
    const today = dayKey(now().getTime());
    const rollup = (await readRollup(dir, logger)) ?? emptyRollup();
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
            records.push(...await readDayFile(dir, name, logger));
        absorbed = {
            upto: fileDay(cold[cold.length - 1]),
            ...mergeSummaries(rollup, summarizeRecords(records, resolve)),
        };
        await writeRollup(dir, absorbed).catch((error) => {
            logger.error('[token-usage] cannot write rollup:', error);
        });
    }
    const fresh = [];
    for (const name of hot)
        fresh.push(...await readDayFile(dir, name, logger));
    return { dataDir: dir, ...mergeSummaries(absorbed, summarizeRecords(fresh, resolve)) };
}
//# sourceMappingURL=stats.js.map