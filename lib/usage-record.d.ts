/**
 * Pure record vocabulary of the token-usage plugin: the JSONL row type, its
 * projection from a session event, and lenient line parsing for the dedupe
 * scan. No I/O and no runtime imports, so every consumer shares one wire
 * format. Rows stay minimal: request id, model, the four base token buckets,
 * time, and session id — absent optional buckets are omitted, never null.
 *
 * @module token-usage/usage-record
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Provider-reported token buckets; absent optional buckets are omitted. */
export interface UsageFields {
    /** Uncached input tokens (billed input = this + cacheRead + cacheWrite). */
    inputTokens: number;
    /** Output tokens. */
    outputTokens: number;
    /** Cache-hit input tokens; omitted when the provider reported none. */
    cacheReadTokens?: number;
    /** Cache-write input tokens; omitted when the provider reported none. */
    cacheWriteTokens?: number;
}
/** One JSONL row: one successful model request. */
export interface UsageRecord {
    /** Stable request identity: the assistant message id (dedupe key). */
    requestId: string;
    /** Session-event wall time, epoch milliseconds. */
    time: number;
    /** Owning session id. */
    sessionId: string;
    /** Provider model id that produced the message. */
    model: string;
    /** Token buckets; omitted when the provider reported no usage at all. */
    usage?: UsageFields;
}
/**
 * Project the event's optional provider usage into the four base buckets.
 * A missing record or an invalid required bucket renders the whole usage
 * absent: the row still records the request, but its numbers are not trusted.
 */
export declare function projectUsage(usage: TokenUsage | undefined): UsageFields | undefined;
/** Build the log row for one assistant/message session event. */
export declare function recordFromEvent(event: SessionEvent<'assistant/message'>, sessionId: string): UsageRecord;
/** One JSONL line without the trailing newline. */
export declare function serializeRecord(record: UsageRecord): string;
/**
 * Parse one JSONL line back into a record. Extra fields are ignored and null
 * buckets are normalized to omission, so rows written by older field sets
 * still dedupe (their request id is absorbed) without being rewritten.
 * @returns the record, or null when the line is not a valid row.
 */
export declare function parseRecord(line: string): UsageRecord | null;
//# sourceMappingURL=usage-record.d.ts.map