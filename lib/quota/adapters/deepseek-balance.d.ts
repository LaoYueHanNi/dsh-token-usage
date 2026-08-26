/**
 * DeepSeek balance adapter: the pay-as-you-go account balance of the
 * official DeepSeek platform — the dsh default provider (`deepseek-official`).
 *
 * Endpoint: `GET {root}/user/balance` with a Bearer key. The root is the
 * profile's inference `baseURL` with a trailing OpenAI-compatible `/v1`
 * stripped (so `https://api.deepseek.com/v1` hits the official
 * `/user/balance`, not `/v1/user/balance`), defaulting to
 * `https://api.deepseek.com`. The response lists one entry per currency;
 * the panel shows the CNY figure. A balance window has no reset and no
 * total — the amount IS the signal.
 *
 * @module token-usage/quota/adapters/deepseek-balance
 */
import type { QuotaAdapter } from '../types.ts';
/** The DeepSeek account-balance adapter. */
export declare const deepseekBalanceAdapter: QuotaAdapter;
//# sourceMappingURL=deepseek-balance.d.ts.map