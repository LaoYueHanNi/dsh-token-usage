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
import { type LoggerLike } from './log.ts';
import type { UsageRecord } from './usage-record.ts';
import type { UsageDayRow, UsageHourRow, UsageModelRow, UsageRateRow, UsageTotals } from './wire.ts';
declare const ROLLUP_FILE = "rollup.json";
declare const TMP_FILE = "rollup.json.tmp";
/** The rollup file name, exported so callers (e.g. the post-sync
 * invalidation in index.ts) can drop the derived state by one authority. */
export { ROLLUP_FILE as ROLLUP_FILE_NAME };
export { TMP_FILE as ROLLUP_TMP_FILE_NAME };
/** The on-disk rollup: the aggregate of every day file named ≤ {@link RollupFile.upto}. */
export interface RollupFile {
    /** Inclusive upper date (`YYYY-MM-DD`) of the day files already absorbed. */
    upto: string;
    /** Totals over every absorbed record. */
    total: UsageTotals;
    /** Per-local-day rows of the absorbed records, ascending by day. */
    byDay: UsageDayRow[];
    /** Per-hour × per-model rows of the absorbed records, ascending by hour
     * then model — feeds the single-day hourly trend chart without rereading
     * the frozen day files. */
    byHour: UsageHourRow[];
    /** Per-model rows of the absorbed records, descending on request count. */
    byModel: UsageModelRow[];
    /** Per-(day, model, rate identity) rows of the absorbed records — rule
     * identities, never prices, so an updated pricing table re-prices the
     * absorbed history without a rebuild. */
    rateRows: UsageRateRow[];
    /** The newest absorbed records, descending by time (bounded window). */
    recent: UsageRecord[];
}
/**
 * Load the rollup of one data directory. A missing, malformed, or
 * structurally invalid rollup reads as null — the caller then rebuilds it
 * from the day files, so corruption never blocks the stats read. Invalid
 * entries inside the recent window are dropped instead of failing the whole
 * rollup, mirroring how malformed JSONL lines are skipped.
 * @param dir - the plugin's data directory.
 */
export declare function readRollup(dir: string, logger?: LoggerLike): Promise<RollupFile | null>;
/**
 * Persist the rollup atomically (temp file + rename), so a crash mid-write
 * leaves either the old or the new rollup, never a torn one.
 * @param dir - the plugin's data directory.
 * @param rollup - the rollup to persist.
 */
export declare function writeRollup(dir: string, rollup: RollupFile): Promise<void>;
//# sourceMappingURL=rollup.d.ts.map