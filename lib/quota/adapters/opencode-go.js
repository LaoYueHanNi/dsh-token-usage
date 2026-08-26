/**
 * OpenCode Go adapter (Zen Go 订阅套餐): the 5-hour rolling window, the
 * weekly window, and the monthly window of the Go membership.
 *
 * Endpoint: `GET https://opencode.ai/zen/go/v1/usage` with a Bearer key
 * (the same Anthropic-compatible OpenCode key used for inference). The
 * body is `{ usage: { rolling, weekly, monthly } }`; each lane carries
 * `{ status, percent, resetsAt }`. `percent` is the USED share (0–100)
 * — the field lives under `usage`, and a live account with a fresh 5-hour
 * bucket answers `0`. `resetsAt` is ISO-8601. A lane without a computable
 * percent is skipped rather than painted empty; `status: "rate-limited"`
 * still paints when percent is present.
 *
 * Matching must not collide with OpenCode Zen (pay-as-you-go, route
 * `opencode`, path `/zen/v1`): the catalog route is `opencode-go`, and a
 * custom route matches only when its base URL path contains `/zen/go`.
 *
 * @module token-usage/quota/adapters/opencode-go
 */
import { fetchJson, numberOf } from "../http.js";
import { QuotaQueryError } from "../types.js";
/** The quota endpoint is fixed; inference hosts vary by model protocol. */
const QUOTA_URL = 'https://opencode.ai/zen/go/v1/usage';
/** The pi-ai catalog route; `opencode` is Zen pay-as-you-go, not this. */
const ROUTE_OPENCODE_GO = 'opencode-go';
/** The three lanes the endpoint reports, in panel order. */
const LANES = [
    { field: 'rolling', tier: 'five_hour' },
    { field: 'weekly', tier: 'weekly' },
    { field: 'monthly', tier: 'monthly' },
];
/** Whether a base URL is the Go subscription (path `/zen/go`), not Zen. */
export function isOpenCodeGoUrl(baseUrl) {
    if (baseUrl === undefined || baseUrl === '')
        return false;
    try {
        const url = new URL(baseUrl);
        const host = url.hostname.toLowerCase();
        if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai'))
            return false;
        return url.pathname.toLowerCase().includes('/zen/go');
    }
    catch {
        return false;
    }
}
/** ISO-8601 (or epoch) → epoch ms; unparseable values drop the reset. */
function resetAtOf(value) {
    if (typeof value === 'string' && value.trim() !== '') {
        const ms = Date.parse(value);
        return Number.isFinite(ms) && ms > 0 ? ms : undefined;
    }
    const n = numberOf(value);
    if (n === undefined || n <= 0)
        return undefined;
    return n < 1e11 ? n * 1000 : n;
}
/** One usage lane → a used-percent window, or undefined when unpaintable. */
function windowOf(tier, raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const lane = raw;
    const usedPercent = numberOf(lane.percent);
    if (usedPercent === undefined)
        return undefined;
    const resetAt = resetAtOf(lane.resetsAt);
    return {
        tier,
        usedPercent: Math.min(100, usedPercent),
        ...(resetAt !== undefined ? { resetAt } : {}),
    };
}
/** The OpenCode Go adapter: 5-hour + weekly + monthly windows. */
export const opencodeGoAdapter = {
    id: 'opencode-go',
    label: 'OpenCode Go',
    routes: [ROUTE_OPENCODE_GO],
    matches(input) {
        if (input.provider === ROUTE_OPENCODE_GO)
            return true;
        return isOpenCodeGoUrl(input.baseUrl);
    },
    async query(ctx) {
        const body = await fetchJson(ctx, QUOTA_URL, { authorization: `Bearer ${ctx.apiKey}` });
        if (typeof body !== 'object' || body === null) {
            throw new QuotaQueryError('parse', 'response is not an object');
        }
        const usage = body.usage;
        if (typeof usage !== 'object' || usage === null) {
            throw new QuotaQueryError('parse', 'missing "usage" object');
        }
        const record = usage;
        const windows = [];
        for (const lane of LANES) {
            const window = windowOf(lane.tier, record[lane.field]);
            if (window !== undefined)
                windows.push(window);
        }
        if (windows.length === 0) {
            throw new QuotaQueryError('parse', 'no usable rolling/weekly/monthly windows in "usage"');
        }
        return { windows };
    },
};
//# sourceMappingURL=opencode-go.js.map