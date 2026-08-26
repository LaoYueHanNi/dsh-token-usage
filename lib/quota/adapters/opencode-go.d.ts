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
import type { QuotaAdapter } from '../types.ts';
/** Whether a base URL is the Go subscription (path `/zen/go`), not Zen. */
export declare function isOpenCodeGoUrl(baseUrl: string | undefined): boolean;
/** The OpenCode Go adapter: 5-hour + weekly + monthly windows. */
export declare const opencodeGoAdapter: QuotaAdapter;
//# sourceMappingURL=opencode-go.d.ts.map