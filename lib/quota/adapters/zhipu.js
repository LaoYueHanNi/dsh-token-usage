/**
 * Zhipu GLM Coding Plan adapter (智谱 GLM 套餐): the 5-hour + weekly
 * windows of the personal/international coding-plan subscriptions.
 *
 * Endpoint: `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`
 * (international `https://api.z.ai/...`, same shape), authorized with the
 * coding-plan API key in the `Authorization` header WITHOUT the `Bearer`
 * prefix — a quirk cc-switch documented; adding the prefix authenticates
 * as anonymous and answers an error envelope.
 *
 * Response (`data.limits[]`): the `unit`/`number` pair gives the window
 * LENGTH (1 days, 3 hours, 5 minutes, 6 weeks — cc-switch and token-monitor
 * read the same table), classifying the bucket: ≤ 6 hours is the 5-hour
 * window, roughly-two-weeks-and-under is weekly, a billing month is
 * monthly; a bare unit 6 stays the weekly bucket whatever its number
 * (observed as 6/1 and 6/7 in the wild). Only when no length is
 * computable does the reset-time-ascending heuristic apply — at a period's
 * end the weekly bucket can reset BEFORE the 5-hour one, so pure time
 * sorting swaps the two (cc-switch issue #3036). The entry `type` names
 * the metered resource: `CREDIT_LIMIT` on the v3 coding plans
 * (usage/currentValue/remaining credits), `TOKENS_LIMIT` on the older
 * ones — the window fields and classification are identical either way.
 * The used share comes from the credit totals when they are present —
 * `max(usage - remaining, currentValue) / usage`, the console's own
 * arithmetic — with `percentage` as the fallback; a share NEITHER source
 * can produce is an unpaintable window, skipped rather than fabricated
 * as 0% used. `nextResetTime` is epoch ms; `data.level` names the plan
 * tier. Tolerances cc-switch learned in the wild: the `type` comparison
 * is case-insensitive (upstream has been observed casing it differently),
 * and an HTTP-200 `success: false` + `msg` envelope is a business error,
 * not a payload to dig into.
 *
 * @module token-usage/quota/adapters/zhipu
 */
import { fetchJson, hostOf, numberOf } from "../http.js";
import { QuotaQueryError } from "../types.js";
/** Domestic (open.bigmodel.cn) quota host; the international station mirrors the shape. */
const DOMESTIC_QUOTA_BASE = 'https://open.bigmodel.cn';
/** International (api.z.ai) quota host. */
const INTERNATIONAL_QUOTA_BASE = 'https://api.z.ai';
/** The quota monitor path, identical on both stations. */
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
/** pi-ai catalog route of the domestic coding plan; the international one is `zai`. */
const ROUTE_CODING_CN = 'zai-coding-cn';
const ROUTE_ZAI = 'zai';
/** The `unit` vocabulary of `data.limits[]`: 3 is the 5-hour window, 6 the
 * weekly one (observed as 6/7 and 6/1 in the wild; the primary value
 * decides). */
const UNIT_FIVE_HOUR = 3;
const UNIT_WEEKLY = 6;
/** A billing month and longer: window lengths past this read monthly. */
const WEEKLY_MAX_MINUTES = 13 * 24 * 60;
/** Window length in minutes from the (unit, number) pair, or undefined
 * when either side is missing/unusable. The table is shared with
 * token-monitor's zai reader: 1 = days, 3 = hours, 5 = minutes, 6 = weeks. */
function windowMinutesOf(unit, count) {
    if (unit === undefined || count === undefined || count <= 0)
        return undefined;
    if (unit === 5)
        return count;
    if (unit === UNIT_FIVE_HOUR)
        return count * 60;
    if (unit === 1)
        return count * 24 * 60;
    if (unit === UNIT_WEEKLY)
        return count * 7 * 24 * 60;
    return undefined;
}
/** Which window tier a limit entry belongs to, or undefined when the
 * entry carries no computable classification (the reset-time heuristic
 * takes those). */
function tierOf(unit, minutes) {
    if (minutes !== undefined) {
        if (minutes <= 360)
            return 'five_hour';
        // Unit 6 names the weekly bucket however its number reads — 6/7 was
        // observed serving the weekly window, not seven weeks of it.
        if (unit === UNIT_WEEKLY)
            return 'weekly';
        return minutes <= WEEKLY_MAX_MINUTES ? 'weekly' : 'monthly';
    }
    if (unit === UNIT_FIVE_HOUR)
        return 'five_hour';
    if (unit === UNIT_WEEKLY)
        return 'weekly';
    return undefined;
}
/** The used share of one limit entry. The credit totals are the primary
 * source — `max(usage - remaining, currentValue) / usage`, the console's
 * own arithmetic — and the explicit `percentage` is the fallback; a share
 * neither source can produce reads as undefined (an unpaintable window),
 * never as a fabricated 0%. */
function usedPercentOf(limit) {
    const total = numberOf(limit.usage);
    if (total !== undefined && total > 0) {
        const remaining = numberOf(limit.remaining);
        const current = numberOf(limit.currentValue);
        let used;
        if (remaining !== undefined) {
            const fromRemaining = total - remaining;
            used = current === undefined ? fromRemaining : Math.max(fromRemaining, current);
        }
        else if (current !== undefined) {
            used = current;
        }
        if (used !== undefined) {
            const clamped = Math.min(Math.max(used, 0), total);
            return (clamped / total) * 100;
        }
    }
    return numberOf(limit.percentage);
}
/** The limit-entry `type` vocabulary: which resource a window meters. The
 * v3 coding plans answer `CREDIT_LIMIT` (usage/currentValue/remaining
 * credits); the older TOKENS_LIMIT shape carries identical window fields,
 * so both classify the same way. Cased variants land through the
 * case-insensitive compare below. */
const KNOWN_LIMIT_TYPES = new Set(['TOKENS_LIMIT', 'CREDIT_LIMIT']);
/** Whether the base-URL host (or the route key) marks the international station. */
function isInternational(input) {
    if (input.provider === ROUTE_ZAI)
        return true;
    const host = hostOf(input.baseUrl);
    return host === 'api.z.ai' || (host?.endsWith('.z.ai') ?? false);
}
/** The quota host of the station this route resolves to. */
function quotaBase(input) {
    return isInternational(input) ? INTERNATIONAL_QUOTA_BASE : DOMESTIC_QUOTA_BASE;
}
/** The Zhipu GLM coding-plan adapter: 5-hour + weekly windows. */
export const zhipuAdapter = {
    id: 'zhipu-coding-plan',
    label: 'Zhipu GLM Coding Plan',
    routes: [ROUTE_CODING_CN, ROUTE_ZAI],
    matches(input) {
        if (input.provider === ROUTE_CODING_CN || input.provider === ROUTE_ZAI)
            return true;
        const host = hostOf(input.baseUrl);
        // bigmodel.cn covers open.bigmodel.cn and the api subdomains; z.ai the
        // international station. Host match is what catches user-declared
        // routes pointing at the same endpoints under a custom name.
        return host !== undefined
            && (host === 'bigmodel.cn' || host.endsWith('.bigmodel.cn') || host === 'z.ai' || host.endsWith('.z.ai'));
    },
    async query(ctx) {
        // No Bearer prefix — see the module note. The content-type and
        // accept-language headers mirror cc-switch's request byte for byte.
        const body = await fetchJson(ctx, quotaBase(ctx) + QUOTA_PATH, {
            authorization: ctx.apiKey,
            'content-type': 'application/json',
            'accept-language': 'en-US,en',
        });
        if (typeof body !== 'object' || body === null) {
            throw new QuotaQueryError('parse', 'missing "data" object');
        }
        const envelope = body;
        // Business error: HTTP 200 with success:false carries the cause in
        // "msg" (the anonymous-auth envelope has this shape, for one).
        if (envelope.success === false) {
            const msg = typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : 'unknown error';
            throw new QuotaQueryError('http', `API error: ${msg}`);
        }
        const data = envelope.data;
        if (typeof data !== 'object' || data === null) {
            throw new QuotaQueryError('parse', 'missing "data" object');
        }
        const record = data;
        if (!Array.isArray(record.limits)) {
            throw new QuotaQueryError('parse', 'missing "data.limits" array');
        }
        // Classify each limit to its window tier — by the (unit, number)
        // length first, by the bare unit kind when the number is missing —
        // with the first entry of a tier winning and later duplicates of a
        // filled tier dropped (a surplus bucket never masquerades as another
        // tier). Entries with no computable tier keep to the tail for the
        // reset-time heuristic old plans need.
        let fiveHour;
        let weekly;
        let monthly;
        const unclassified = [];
        const observedTypes = [];
        for (const raw of record.limits) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const limit = raw;
            if (typeof limit.type === 'string')
                observedTypes.push(limit.type);
            // Case-insensitive across the known vocabulary (upstream has been
            // observed casing it differently); a MISSING type still counts (old
            // plans predate the field).
            if (limit.type !== undefined && !KNOWN_LIMIT_TYPES.has(String(limit.type).toUpperCase()))
                continue;
            const usedPercent = usedPercentOf(limit);
            // An unpaintable window — no totals to back-compute the share from,
            // no `percentage` either — is skipped, not painted as 0% used.
            if (usedPercent === undefined)
                continue;
            const resetAt = numberOf(limit.nextResetTime);
            const window = {
                tier: 'five_hour',
                usedPercent,
                ...(resetAt !== undefined ? { resetAt } : {}),
            };
            const unit = numberOf(limit.unit);
            const tier = tierOf(unit, windowMinutesOf(unit, numberOf(limit.number)));
            if (tier === 'five_hour' && fiveHour === undefined)
                fiveHour = window;
            else if (tier === 'weekly' && weekly === undefined)
                weekly = { ...window, tier: 'weekly' };
            else if (tier === 'monthly' && monthly === undefined)
                monthly = { ...window, tier: 'monthly' };
            else if (tier === undefined)
                unclassified.push(window);
        }
        // Heuristic fallback for limits without a computable tier: entries
        // without a reset first (a 0%-state 5-hour bucket may carry none),
        // then ascending reset time filling whichever slot is still empty.
        // The unit field exists precisely because time sorting alone swaps
        // the two at a period's end; tier-less payloads are the single-window
        // old plans, where the order is trivial.
        unclassified.sort((a, b) => (a.resetAt ?? 0) - (b.resetAt ?? 0));
        for (const window of unclassified) {
            if (fiveHour === undefined)
                fiveHour = window;
            else if (weekly === undefined)
                weekly = { ...window, tier: 'weekly' };
        }
        const windows = [];
        if (fiveHour !== undefined)
            windows.push(fiveHour);
        if (weekly !== undefined)
            windows.push(weekly);
        if (monthly !== undefined)
            windows.push(monthly);
        if (windows.length === 0) {
            const seen = observedTypes.length > 0 ? ` (types: ${observedTypes.join(', ')})` : '';
            throw new QuotaQueryError('parse', `no TOKENS_LIMIT/CREDIT_LIMIT windows in "data.limits"${seen}`);
        }
        const level = record.level;
        return {
            windows,
            ...(typeof level === 'string' && level !== '' ? { planTier: level } : {}),
        };
    },
};
//# sourceMappingURL=zhipu.js.map