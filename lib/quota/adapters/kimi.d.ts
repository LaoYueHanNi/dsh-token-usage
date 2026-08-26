/**
 * Kimi For Coding adapter (月之暗面编程套餐): the 5-hour rolling window(s)
 * and the weekly window of the coding-plan subscription.
 *
 * Endpoint: `GET https://api.kimi.com/coding/v1/usages` with a Bearer key.
 * The response carries `limits[]` — one entry per active 5-hour bucket,
 * and there CAN be several (the window rolls per request batch) — plus a
 * top-level `usage` object for the weekly bucket. Each bucket reports
 * `{ limit, remaining, resetTime }`; the used share is derived.
 *
 * Route matching is host-first: the pi-ai `moonshotai` routes point at the
 * standard Moonshot API (api.moonshot.cn / api.moonshot.ai), which has no
 * coding-plan quota endpoint, so those must never match by route key. The
 * coding plan is identified by its api.kimi.com host — exactly the signal
 * cc-switch's `detect_provider` uses — or by the catalog route
 * `kimi-coding` (whose catalog endpoint is filled in when the profile
 * omits `baseURL`).
 *
 * @module token-usage/quota/adapters/kimi
 */
import type { QuotaAdapter } from '../types.ts';
/** Whether a host is the Kimi coding-plan endpoint (subdomains included). */
export declare function isKimiHost(baseUrl: string | undefined): boolean;
/** The Kimi For Coding adapter: 5-hour + weekly windows. */
export declare const kimiAdapter: QuotaAdapter;
//# sourceMappingURL=kimi.d.ts.map