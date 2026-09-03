/**
 * Durable JSONL store of the token-usage plugin: per-local-day files, a
 * serialized append queue, and the process-wide request-id dedupe set that
 * both the live hook and the manual sync share.
 *
 * @module token-usage/usage-log
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consoleLogger } from "./log.js";
import { parseRecord, serializeRecord } from "./usage-record.js";
const DAY_FILE = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/u;
/** Test for this store's per-day file names; the migration shares the naming contract. */
export { DAY_FILE };
/** Day-file name for a local-time date, e.g. `usage-2026-01-15.jsonl`. */
export function dayFileName(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `usage-${year}-${month}-${day}.jsonl`;
}
function dayFilePath(dir, date) {
    return join(dir, dayFileName(date));
}
/**
 * Append-only per-day JSONL log with request-id dedupe.
 *
 * Ordering: every append runs on one promise chain, so concurrent callers
 * land in call order. Dedupe: a request id is claimed synchronously before
 * its append is queued; a failed append releases the claim, so the row can
 * be retried later.
 */
export class UsageLog {
    dir;
    now;
    logger;
    seen = new Set();
    queue = Promise.resolve();
    ready;
    /**
   * @param dir - absolute data directory (created lazily on first write).
   * @param now - clock source for day-file selection (test seam).
   * @param logger - diagnostic sink; defaults to console.
   */
    constructor(dir, now = () => new Date(), logger = consoleLogger) {
        this.dir = dir;
        this.now = now;
        this.logger = logger;
    }
    /** Whether a request id is already known to this log. */
    has(requestId) {
        return this.seen.has(requestId);
    }
    /**
     * Settle every queued append. The chain never rejects (each task absorbs
     * its own failure), so this is the quiescence point a data-directory
     * migration waits on before reading the files.
     * @returns settlement after the last queued append.
     */
    flush() {
        return this.queue;
    }
    /**
     * Rebuild the dedupe set from every existing day file. Malformed lines are
     * skipped with a console diagnostic; unreadable files are skipped the same
     * way, so a corrupt log never blocks the sync.
     */
    async scan() {
        this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
        await this.ready;
        let names;
        try {
            names = await readdir(this.dir);
        }
        catch (error) {
            this.logger.error('[token-usage] cannot list data dir ' + this.dir + ':', error);
            return;
        }
        for (const name of names) {
            if (!DAY_FILE.test(name))
                continue;
            const text = await readFile(join(this.dir, name), 'utf8').catch((error) => {
                this.logger.error(`[token-usage] cannot read ${name}:`, error);
                return '';
            });
            for (const line of text.split('\n')) {
                if (line === '')
                    continue;
                const record = parseRecord(line);
                if (record === null) {
                    this.logger.error(`[token-usage] skipping malformed line in ${name}: ${line.slice(0, 120)}`);
                    continue;
                }
                this.seen.add(record.requestId);
            }
        }
    }
    /**
     * Persist one record unless its request id was already written.
     * @returns true when the row was appended, false when deduped.
     */
    record(record) {
        if (this.seen.has(record.requestId))
            return Promise.resolve(false);
        // Claim before queueing: a concurrent call with the same id dedupes here.
        this.seen.add(record.requestId);
        const task = this.queue.then(async () => {
            await this.ensureDir();
            await this.appendOnce(record);
        });
        // A failed append must not poison the chain for later rows.
        this.queue = task.catch(() => { });
        return task
            .then(() => true)
            .catch((error) => {
            // Release the claim so a later sync can retry this row.
            this.seen.delete(record.requestId);
            this.logger.error('[token-usage] append failed:', error);
            return false;
        });
    }
    /** The directory is created once and remembered; an external deletion
     * forces a rebuild on the next append (see {@link appendOnce}). */
    async ensureDir() {
        this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
        await this.ready;
    }
    /**
     * Append one row, self-healing once when the directory vanished after the
     * cached creation: the data location may be removed underneath a running
     * process (a migration that stayed behind, a user cleanup), and failing
     * every append forever after would silently drop the whole session's rows.
     */
    async appendOnce(record) {
        const path = dayFilePath(this.dir, this.now());
        try {
            await appendFile(path, `${serializeRecord(record)}\n`, { flag: 'a' });
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            this.ready = undefined;
            await this.ensureDir();
            await appendFile(path, `${serializeRecord(record)}\n`, { flag: 'a' });
        }
    }
}
//# sourceMappingURL=usage-log.js.map