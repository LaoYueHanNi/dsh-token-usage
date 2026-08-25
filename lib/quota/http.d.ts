/**
 * Shared transport helpers of the quota adapters (node half): one JSON GET
 * that normalizes every failure mode into {@link QuotaQueryError} with the
 * wire's error kind, plus small parsing utilities (host extraction,
 * epoch-ms normalization) every adapter repeats.
 *
 * @module token-usage/quota/http
 */
import type { QuotaQueryContext } from './types.ts';
/**
 * GET one URL and parse the JSON body, normalizing failures: 401/403 →
 * `auth`, other non-2xx → `http`, transport errors (DNS, timeout, abort)
 * → `network`, a body that is not JSON → `parse`. Adapters therefore only
 * throw shape-validation errors of their own.
 * @param ctx - the query context (transport, auth header material, signal).
 * @param url - the absolute quota endpoint.
 * @param headers - extra request headers (most adapters pass Authorization).
 * @returns the parsed body.
 */
export declare function fetchJson(ctx: QuotaQueryContext, url: string, headers?: Record<string, string>): Promise<unknown>;
/** Read a required object field or fail with the normalized parse error. */
export declare function requireObject(value: unknown, field: string): Record<string, unknown>;
/** Read a required array field or fail with the normalized parse error. */
export declare function requireArray(value: unknown, field: string): unknown[];
/** A finite non-negative number off a JSON value, else undefined. */
export declare function numberOf(value: unknown): number | undefined;
/**
 * A money/credit amount off a JSON value: a finite number, or the string
 * form providers actually serialize (DeepSeek and OpenRouter ship `"110.00"`
 * strings), with EITHER sign — a pay-as-you-go account can overdraft
 * (DeepSeek answers `total_balance: "-0.01"`). Everything else, including
 * blank strings, reads undefined.
 */
export declare function amountOf(value: unknown): number | undefined;
/**
 * Normalize a provider timestamp to epoch ms. Providers mix units (MiniMax
 * documents ms, some hand-rolled gateways answer seconds); an absolute
 * epoch in seconds is ≤ ~1.1e10 while the ms form is ≥ 1e12, so anything
 * below the seconds ceiling is re-scaled. Values that fit neither an
 * absolute epoch shape pass through unchanged (the caller clamps).
 */
export declare function toEpochMs(value: unknown): number | undefined;
/**
 * The lowercase hostname of a base URL, or undefined when the string is
 * blank or unparseable — adapters match hosts, never full URLs, because
 * the path spelling differs between the inference and quota endpoints.
 */
export declare function hostOf(baseUrl: string | undefined): string | undefined;
//# sourceMappingURL=http.d.ts.map