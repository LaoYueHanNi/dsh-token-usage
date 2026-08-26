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

import type { QuotaWindow } from '../../wire.ts'
import { amountOf, fetchJson, hostOf } from '../http.ts'
import { QuotaQueryError } from '../types.ts'
import type { QuotaAdapter, QuotaQueryResult } from '../types.ts'

/** The direct adapter's route key (dsh-llm-deepseek). */
const ROUTE_OFFICIAL = 'deepseek-official'
/** Default inference/quota host when the profile carries no override. */
const DEFAULT_BASE = 'https://api.deepseek.com'

/**
 * The platform root a balance query should hit: strip trailing slashes and
 * a trailing OpenAI-compatible `/v1` so a profile of
 * `https://api.deepseek.com/v1` lands on `/user/balance`, not
 * `/v1/user/balance`. A proxy path in front of `/v1` is kept
 * (`https://gw.example/deepseek/v1` → `…/deepseek/user/balance`).
 */
function balanceRootOf(baseUrl: string | undefined): string {
  const raw = baseUrl !== undefined && baseUrl !== '' ? baseUrl : DEFAULT_BASE
  return raw.replace(/\/+$/u, '').replace(/\/v1$/u, '')
}

/** The DeepSeek account-balance adapter. */
export const deepseekBalanceAdapter: QuotaAdapter = {
  id: 'deepseek-balance',
  label: 'DeepSeek Balance',
  routes: [ROUTE_OFFICIAL],
  matches(input) {
    if (input.provider === ROUTE_OFFICIAL) return true
    const host = hostOf(input.baseUrl)
    return host !== undefined && (host === 'deepseek.com' || host.endsWith('.deepseek.com'))
  },
  async query(ctx): Promise<QuotaQueryResult> {
    const base = balanceRootOf(ctx.baseUrl)
    const body = await fetchJson(ctx, `${base}/user/balance`, { authorization: `Bearer ${ctx.apiKey}` })
    if (typeof body !== 'object' || body === null) {
      throw new QuotaQueryError('parse', 'response is not an object')
    }
    const record = body as Record<string, unknown>
    const infos = record.balance_infos
    if (!Array.isArray(infos)) {
      throw new QuotaQueryError('parse', 'missing "balance_infos" array')
    }
    // Prefer the CNY entry; a weird account with only USD falls back to
    // the first entry rather than reporting nothing.
    const pick = infos.find(
      entry => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).currency === 'CNY',
    ) ?? infos.find(entry => typeof entry === 'object' && entry !== null)
    if (pick === undefined) {
      throw new QuotaQueryError('parse', '"balance_infos" is empty')
    }
    const entry = pick as Record<string, unknown>
    // The amounts ship as STRINGS and an overdrawn account answers
    // negative (`"-0.01"` with is_available:false) — the signed string
    // parser keeps both.
    const balance = amountOf(entry.total_balance)
    if (balance === undefined) {
      throw new QuotaQueryError('parse', 'missing numeric "total_balance"')
    }
    const window: QuotaWindow = {
      tier: 'balance',
      remainingValue: balance,
      unit: entry.currency === 'USD' ? 'usd' : 'cny',
    }
    return { windows: [window] }
  },
}
