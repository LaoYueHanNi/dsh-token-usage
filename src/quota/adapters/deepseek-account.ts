/**
 * DeepSeek account adapter: the signed-in account's recharge and bonus
 * wallets (`deepseek-account`), as opposed to the API-key route
 * (`deepseek-official`) which hits `GET /user/balance`.
 *
 * The account route authenticates with the host's stored grant, not an
 * API key. The plugin does not speak the Platform protocol itself — it
 * calls the host `deepseekAccount.getBalance()`, which already owns token
 * refresh, headers, and 401 expiry. A missing service or a `null` read
 * (signed out, or the grant changed mid-query) is `signed-out`: the button
 * stays up and asks the user to sign in. A `failed` wallet read is a
 * network error so the panel's retry actually re-queries.
 *
 * One currency per purse, CNY preferred, matching the API-key adapter's
 * single-figure choice. A zero bonus purse is omitted (the account
 * settings page does the same); a zero or overdrawn recharge purse stays,
 * because that amount is the figure the user is managing.
 *
 * @module token-usage/quota/adapters/deepseek-account
 */

import type { QuotaWindow } from '../../wire.ts'
import { amountOf } from '../http.ts'
import { QuotaQueryError } from '../types.ts'
import type { AccountPurseBalance, AccountPurseWallet, QuotaAdapter, QuotaQueryResult } from '../types.ts'

/** The account provider's route key (llm-deepseek-account). */
const ROUTE_ACCOUNT = 'deepseek-account'

/** CNY when the purse has one, else the first USD entry. */
function pickWallet(wallets: readonly AccountPurseWallet[]): AccountPurseWallet | undefined {
  const known = wallets.filter(wallet => wallet.currency === 'CNY' || wallet.currency === 'USD')
  return known.find(wallet => wallet.currency === 'CNY') ?? known[0]
}

/** One purse as a balance window. Throws when the picked amount is not numeric. */
function purseWindow(wallet: AccountPurseWallet, kind: 'recharge' | 'bonus'): QuotaWindow {
  const amount = amountOf(wallet.balance)
  if (amount === undefined) {
    throw new QuotaQueryError('parse', `missing numeric ${kind} balance`)
  }
  return {
    tier: 'balance',
    remainingValue: amount,
    unit: wallet.currency === 'USD' ? 'usd' : 'cny',
    balanceKind: kind,
  }
}

/** The signed-in DeepSeek account balance adapter. */
export const deepseekAccountAdapter: QuotaAdapter = {
  id: 'deepseek-account',
  label: 'DeepSeek Account',
  routes: [ROUTE_ACCOUNT],
  usesApiKey: false,
  matches(input) {
    return input.provider === ROUTE_ACCOUNT
  },
  async query(ctx): Promise<QuotaQueryResult> {
    if (ctx.readAccountBalance === undefined) {
      throw new QuotaQueryError('signed-out', ROUTE_ACCOUNT)
    }
    let read: AccountPurseBalance | null
    try {
      read = await ctx.readAccountBalance()
    } catch (error) {
      throw new QuotaQueryError('network', error instanceof Error ? error.message : String(error))
    }
    if (read === null) throw new QuotaQueryError('signed-out', ROUTE_ACCOUNT)
    if (read.status !== 'ready' || read.value === undefined) {
      throw new QuotaQueryError('network', 'account balance failed')
    }
    const windows: QuotaWindow[] = []
    const recharge = pickWallet(read.value)
    if (recharge !== undefined) windows.push(purseWindow(recharge, 'recharge'))
    const bonus = read.bonusWallets === undefined ? undefined : pickWallet(read.bonusWallets)
    if (bonus !== undefined) {
      const amount = amountOf(bonus.balance)
      if (amount === undefined) throw new QuotaQueryError('parse', 'missing numeric bonus balance')
      if (amount > 0) {
        windows.push({
          tier: 'balance',
          remainingValue: amount,
          unit: bonus.currency === 'USD' ? 'usd' : 'cny',
          balanceKind: 'bonus',
        })
      }
    }
    if (windows.length === 0) throw new QuotaQueryError('parse', 'no wallet')
    return { windows }
  },
}
