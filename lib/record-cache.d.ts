/**
 * Process-memory cache of parsed usage day files. Frozen (pre-today) files
 * stay resident after the first read; today's file is re-read when its size
 * or mtime changes. Concurrent readers of one directory share one in-flight
 * load (singleflight), so the header chip, the usage tab, and a settings
 * refresh cannot pile overlapping full-directory parses onto the event loop.
 *
 * @module token-usage/record-cache
 */
import type { UsageRecord } from './usage-record.ts';
/** The date part of a day-file name, or null for a foreign name. */
export declare function fileDay(name: string): string | null;
/**
 * Drop cached parses. A missing `dir` clears every directory (test seam);
 * a path drops that directory only (data-directory relocation).
 */
export declare function clearRecordCache(dir?: string): void;
/**
 * Read one day file into records. Malformed lines are skipped silently —
 * the stats read runs on every page refresh and must not spam the console
 * over one bad row. An unreadable file logs once and reads as empty, so a
 * corrupt log never blocks stats.
 * @param dir - the plugin's data directory.
 * @param name - the day-file name.
 */
export declare function readDayFile(dir: string, name: string): Promise<UsageRecord[]>;
/** List the data directory's day-file names in ascending date order ([] when absent). */
export declare function listDayFiles(dir: string): Promise<string[]>;
/**
 * Read every day file into records, serving frozen files from memory after
 * the first parse. An absent data directory yields an empty list.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 */
export declare function readCachedRecords(dir: string, now?: () => Date): Promise<UsageRecord[]>;
/** Populate the cache for one directory so the first stats poll is a memory hit. */
export declare function warmRecordCache(dir: string, now?: () => Date): Promise<void>;
//# sourceMappingURL=record-cache.d.ts.map