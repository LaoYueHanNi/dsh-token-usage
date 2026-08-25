/**
 * MiniMax Coding Plan adapter (国内/国际站): the 5-hour interval window
 * and the optional weekly window.
 *
 * Endpoint: `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`
 * (international `api.minimax.io`, same path) with a Bearer key. Of the
 * `model_remains[]` entries only `model_name: "general"` is the coding
 * quota (video and friends are separate meters). Three semantic quirks
 * cc-switch documented: the percents are REMAINING shares (inverted into
 * used here), a `status == 3` lane is the server's "no entitlement here"
 * PLACEHOLDER (typically a full 100% remaining, sometimes none) that must
 * not paint a window, and business errors ride a 200 with
 * `base_resp.status_code != 0`. The status field itself is optional in
 * live responses — gating on `status == 1` would hide real windows
 * whenever it goes missing — so the guard keys on the placeholder
 * COMBINATION (status 3 with a placeholder-looking percent), not on the
 * status alone (token-monitor's live-verified shapes).
 *
 * @module token-usage/quota/adapters/minimax
 */
import type { QuotaAdapter } from '../types.ts';
/** The MiniMax coding-plan adapter: 5-hour + optional weekly windows. */
export declare const minimaxAdapter: QuotaAdapter;
//# sourceMappingURL=minimax.d.ts.map