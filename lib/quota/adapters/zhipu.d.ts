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
import type { QuotaAdapter } from '../types.ts';
/** The Zhipu GLM coding-plan adapter: 5-hour + weekly windows. */
export declare const zhipuAdapter: QuotaAdapter;
//# sourceMappingURL=zhipu.d.ts.map