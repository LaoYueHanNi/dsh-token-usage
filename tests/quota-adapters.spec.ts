/**
 * Quota adapter unit tests: one fixture per provider response shape, lifted
 * from the cc-switch provider-usage research (whose endpoints were lifted
 * from working implementations), plus the request-shape assertions the
 * quirky providers need (Zhipu's Bearer-less Authorization, Kimi's fixed
 * host, MiniMax's station choice).
 */
import { describe, expect, it, vi } from 'vitest'
import type { QuotaQueryContext } from '../src/quota/types.ts'
import { QuotaQueryError } from '../src/quota/types.ts'
import { commandCodeAdapter } from '../src/quota/adapters/command-code.ts'
import { deepseekAccountAdapter } from '../src/quota/adapters/deepseek-account.ts'
import { deepseekBalanceAdapter } from '../src/quota/adapters/deepseek-balance.ts'
import { kimiAdapter } from '../src/quota/adapters/kimi.ts'
import { magpieAdapter, MagpieDetector, magpieQuotaUrl } from '../src/quota/adapters/magpie.ts'
import { minimaxAdapter } from '../src/quota/adapters/minimax.ts'
import { opencodeGoAdapter } from '../src/quota/adapters/opencode-go.ts'
import { openrouterAdapter } from '../src/quota/adapters/openrouter.ts'
import { zhipuAdapter } from '../src/quota/adapters/zhipu.ts'

/** Build a query context over a stub transport; the captured calls let the
 * request shape (URL, headers) be asserted. */
function contextOf(
  body: unknown,
  status = 200,
): { ctx: QuotaQueryContext; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { ctx: { provider: 'test', apiKey: 'sk-test', fetchFn }, calls }
}

/** Build a query context whose stub transport answers by URL substring —
 * the multi-endpoint adapters (Command Code) fan out over four paths. An
 * entry without a body answers the given status with `null`. */
function contextOfRoutes(routes: Array<{ match: string; status?: number; body?: unknown }>): {
  ctx: QuotaQueryContext
  calls: Array<{ url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, headers: (init?.headers ?? {}) as Record<string, string> })
    const route = routes.find(entry => href.includes(entry.match))
    const status = route?.status ?? 200
    return new Response(route?.body === undefined ? null : JSON.stringify(route.body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { ctx: { provider: 'test', apiKey: 'sk-test', fetchFn }, calls }
}

describe('zhipuAdapter', () => {
  it('classifies the unit-tagged windows and passes the key WITHOUT Bearer', async () => {
    const { ctx, calls } = contextOf({
      data: {
        level: 'Max',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 62.5, nextResetTime: 1_780_000_000_000 },
          { type: 'TOKENS_LIMIT', unit: 6, percentage: 40, nextResetTime: 1_780_400_000_000 },
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.planTier).toBe('Max')
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 62.5, resetAt: 1_780_000_000_000 },
      { tier: 'weekly', usedPercent: 40, resetAt: 1_780_400_000_000 },
    ])
    expect(calls[0]?.url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    expect(calls[0]?.headers.authorization).toBe('sk-test')
  })

  it('falls back to the reset-time heuristic for unit-less old plans', async () => {
    const { ctx } = contextOf({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 55, nextResetTime: 1_780_000_000_000 },
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'five_hour', usedPercent: 55, resetAt: 1_780_000_000_000 }])
  })

  it('fills both slots when two unit-less entries arrive (reset-ascending)', async () => {
    const { ctx } = contextOf({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 20, nextResetTime: 1_780_400_000_000 },
          { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: 1_780_000_000_000 },
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 10, resetAt: 1_780_000_000_000 },
      { tier: 'weekly', usedPercent: 20, resetAt: 1_780_400_000_000 },
    ])
  })

  it('matches the type field case-insensitively and skips a window with no computable share', async () => {
    // The unit-3 entry carries neither credit totals nor a percentage —
    // an unpaintable window, dropped rather than fabricated as 0% used.
    const { ctx } = contextOf({
      data: {
        limits: [
          { type: 'tokens_limit', unit: 3 },
          { type: 'TOKENS_Limit', unit: 6, percentage: 40 },
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'weekly', usedPercent: 40 }])
  })

  it('surfaces an HTTP-200 business error envelope instead of digging into it', async () => {
    const { ctx } = contextOf({ success: false, msg: 'token invalid', data: null })
    await expect(zhipuAdapter.query(ctx)).rejects.toMatchObject({
      kind: 'http',
      message: 'API error: token invalid',
    })
  })

  it('names the observed limit types when no window can be parsed', async () => {
    const { ctx } = contextOf({ data: { limits: [{ type: 'CONCURRENCY_LIMIT', percentage: 1 }] } })
    const failure = await zhipuAdapter.query(ctx).catch(error => error as QuotaQueryError)
    expect(failure).toBeInstanceOf(QuotaQueryError)
    expect(failure.kind).toBe('parse')
    expect(failure.message).toContain('types: CONCURRENCY_LIMIT')
  })

  it('parses the v3 CREDIT_LIMIT shape verbatim (a real coding-plan response)', async () => {
    const { ctx } = contextOf({
      code: 200,
      msg: '操作成功',
      success: true,
      data: {
        level: 'lite',
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 1521, remaining: 478, percentage: 76, nextResetTime: 1_787_688_897_024 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 3306, remaining: 6693, percentage: 33, nextResetTime: 1_788_270_271_994 },
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.planTier).toBe('lite')
    expect(result.windows).toHaveLength(2)
    // The credit totals override the coarse `percentage`: the used count is
    // max(usage - remaining, currentValue) — 1522 of 2000, 3307 of 10000.
    expect(result.windows[0]).toMatchObject({ tier: 'five_hour', resetAt: 1_787_688_897_024 })
    expect(result.windows[0]?.usedPercent).toBeCloseTo(76.1, 5)
    expect(result.windows[1]).toMatchObject({ tier: 'weekly', resetAt: 1_788_270_271_994 })
    expect(result.windows[1]?.usedPercent).toBeCloseTo(33.07, 5)
  })

  it('derives the share from credit totals when percentage is missing', async () => {
    const { ctx } = contextOf({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 1521, remaining: 478, nextResetTime: 1_787_688_897_024 },
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]?.tier).toBe('five_hour')
    expect(result.windows[0]?.usedPercent).toBeCloseTo(76.1, 5)
  })

  it('classifies the extended unit vocabulary by window length', async () => {
    const { ctx } = contextOf({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 5, number: 300, percentage: 10 }, // 300 minutes → the 5-hour bucket
          { type: 'CREDIT_LIMIT', unit: 1, number: 30, percentage: 30 }, // 30 days → monthly
          { type: 'CREDIT_LIMIT', unit: 1, number: 7, percentage: 20 }, // 7 days → weekly
        ],
      },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 10 },
      { tier: 'weekly', usedPercent: 20 },
      { tier: 'monthly', usedPercent: 30 },
    ])
  })

  it('keeps unit 6 the weekly bucket whatever its number (6/7 observed in the wild)', async () => {
    const { ctx } = contextOf({
      data: { limits: [{ type: 'CREDIT_LIMIT', unit: 6, number: 7, percentage: 40 }] },
    })
    const result = await zhipuAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'weekly', usedPercent: 40 }])
  })

  it('queries the international station for zai routes', async () => {
    const { ctx, calls } = contextOf({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 1 }] } })
    await zhipuAdapter.query({ ...ctx, provider: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4' })
    expect(calls[0]?.url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
  })

  it('normalizes 401 into the auth error kind and rejects shape-less bodies', async () => {
    const authed = contextOf({ message: 'unauthorized' }, 401)
    await expect(zhipuAdapter.query(authed.ctx)).rejects.toMatchObject({ kind: 'auth' })
    const malformed = contextOf({ unexpected: true })
    await expect(zhipuAdapter.query(malformed.ctx)).rejects.toBeInstanceOf(QuotaQueryError)
  })

  it('matches catalog routes, custom hosts, and rejects unrelated hosts', () => {
    expect(zhipuAdapter.matches({ provider: 'zai-coding-cn' })).toBe(true)
    expect(zhipuAdapter.matches({ provider: 'my-gateway', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' })).toBe(true)
    expect(zhipuAdapter.matches({ provider: 'zai' })).toBe(true)
    expect(zhipuAdapter.matches({ provider: 'deepseek-official', baseUrl: 'https://api.deepseek.com' })).toBe(false)
    expect(zhipuAdapter.matches({ provider: 'zai-coding-cn', baseUrl: 'https://api.deepseek.com' })).toBe(true)
  })
})

describe('kimiAdapter', () => {
  it('picks the freshest 5-hour bucket and derives the weekly window', async () => {
    const { ctx, calls } = contextOf({
      limits: [
        { detail: { limit: 500, remaining: 400, resetTime: 1_780_000_000_000 } },
        { detail: { limit: 500, remaining: 450, resetTime: 1_780_003_600_000 } },
      ],
      usage: { limit: 2000, remaining: 1500, resetTime: 1_780_400_000_000 },
    })
    const result = await kimiAdapter.query(ctx)
    expect(result.windows).toEqual([
      // The bucket resetting latest is the live one: (500-450)/500 = 10%.
      { tier: 'five_hour', usedPercent: 10, resetAt: 1_780_003_600_000 },
      { tier: 'weekly', usedPercent: 25, resetAt: 1_780_400_000_000 },
    ])
    expect(calls[0]?.url).toBe('https://api.kimi.com/coding/v1/usages')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test')
  })

  it('matches the coding-plan host and the catalog route — not moonshotai', () => {
    expect(kimiAdapter.matches({ provider: 'kimi-coding' })).toBe(true)
    expect(kimiAdapter.matches({ provider: 'moonshotai', baseUrl: 'https://api.kimi.com/coding/v1' })).toBe(true)
    expect(kimiAdapter.matches({ provider: 'moonshotai-cn', baseUrl: 'https://api.moonshot.cn/v1' })).toBe(false)
    expect(kimiAdapter.matches({ provider: 'moonshotai' })).toBe(false)
  })
})

describe('minimaxAdapter', () => {
  it('inverts the remaining percents of the general entry onto used windows', async () => {
    const { ctx, calls } = contextOf({
      model_remains: [
        { model_name: 'video', current_interval_remaining_percent: 90, end_time: 1 },
        {
          model_name: 'general',
          current_interval_status: 1,
          current_weekly_status: 1,
          current_interval_remaining_percent: 30,
          current_weekly_remaining_percent: 60,
          end_time: 1_780_000_000_000,
          weekly_end_time: 1_780_400_000_000,
        },
      ],
      base_resp: { status_code: 0 },
    })
    const result = await minimaxAdapter.query(ctx)
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 70, resetAt: 1_780_000_000_000 },
      { tier: 'weekly', usedPercent: 40, resetAt: 1_780_400_000_000 },
    ])
    expect(calls[0]?.url).toBe('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test')
  })

  it('skips the weekly window when the plan has none', async () => {
    const { ctx } = contextOf({
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 5, end_time: 1_780_000_000_000 }],
      base_resp: { status_code: 0 },
    })
    const result = await minimaxAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'five_hour', usedPercent: 95, resetAt: 1_780_000_000_000 }])
  })

  it('ignores the placeholder weekly 100% of a no-weekly plan (a real response)', async () => {
    // The general entry answers current_weekly_status: 3 (plan carries NO
    // weekly quota) yet still fills current_weekly_remaining_percent: 100 —
    // only the status gate keeps that phantom window off the panel.
    const { ctx } = contextOf({
      model_remains: [
        {
          start_time: 1_787_673_600_000,
          end_time: 1_787_691_600_000,
          remains_time: 15_926_178,
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          model_name: 'general',
          current_weekly_total_count: 0,
          current_weekly_usage_count: 0,
          weekly_start_time: 1_787_500_800_000,
          weekly_end_time: 1_788_105_600_000,
          weekly_remains_time: 429_926_178,
          current_interval_status: 1,
          current_interval_remaining_percent: 96,
          current_weekly_status: 3,
          current_weekly_remaining_percent: 100,
        },
        {
          model_name: 'video',
          current_interval_status: 3,
          current_interval_remaining_percent: 100,
          current_weekly_status: 3,
          current_weekly_remaining_percent: 100,
        },
      ],
      base_resp: { status_code: 0, status_msg: 'success' },
    })
    const result = await minimaxAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'five_hour', usedPercent: 4, resetAt: 1_787_691_600_000 }])
  })

  it('shows windows whose status fields are missing (live responses can omit them)', async () => {
    // A strict status === 1 gate hid these very real windows whenever the
    // server skipped the optional status fields.
    const { ctx } = contextOf({
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 30,
          current_weekly_remaining_percent: 60,
          end_time: 1_780_000_000_000,
          weekly_end_time: 1_780_400_000_000,
        },
      ],
      base_resp: { status_code: 0 },
    })
    const result = await minimaxAdapter.query(ctx)
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 70, resetAt: 1_780_000_000_000 },
      { tier: 'weekly', usedPercent: 40, resetAt: 1_780_400_000_000 },
    ])
  })

  it('suppresses a status-3 lane only when its percent looks like the placeholder', async () => {
    const absentPercent = contextOf({
      model_remains: [
        {
          model_name: 'general',
          current_interval_status: 3,
          current_weekly_remaining_percent: 45,
          weekly_end_time: 1_780_400_000_000,
        },
      ],
      base_resp: { status_code: 0 },
    })
    const suppressed = await minimaxAdapter.query(absentPercent.ctx)
    // The interval lane (status 3, no percent) is the placeholder; the
    // weekly lane has a real percent and paints.
    expect(suppressed.windows).toEqual([{ tier: 'weekly', usedPercent: 55, resetAt: 1_780_400_000_000 }])

    const realPercents = contextOf({
      model_remains: [
        {
          model_name: 'general',
          current_interval_status: 3,
          current_interval_remaining_percent: 90,
          current_weekly_status: 3,
          current_weekly_remaining_percent: 88,
        },
      ],
      base_resp: { status_code: 0 },
    })
    const shown = await minimaxAdapter.query(realPercents.ctx)
    expect(shown.windows).toEqual([
      { tier: 'five_hour', usedPercent: 10 },
      { tier: 'weekly', usedPercent: 12 },
    ])
  })

  it('surfaces the in-band business error and the international host', async () => {
    const failed = contextOf({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } })
    await expect(minimaxAdapter.query(failed.ctx)).rejects.toMatchObject({ kind: 'http', message: 'invalid api key' })

    const { ctx, calls } = contextOf({
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      base_resp: { status_code: 0 },
    })
    await minimaxAdapter.query({ ...ctx, baseUrl: 'https://api.minimax.io/v1' })
    expect(calls[0]?.url).toBe('https://api.minimax.io/v1/api/openplatform/coding_plan/remains')
  })

  it('picks the station from the catalog route when the profile has no base URL', async () => {
    const international = contextOf({
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      base_resp: { status_code: 0 },
    })
    await minimaxAdapter.query({ ...international.ctx, provider: 'minimax' })
    expect(international.calls[0]?.url).toBe('https://api.minimax.io/v1/api/openplatform/coding_plan/remains')

    const domestic = contextOf({
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      base_resp: { status_code: 0 },
    })
    await minimaxAdapter.query({ ...domestic.ctx, provider: 'minimax-cn' })
    expect(domestic.calls[0]?.url).toBe('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
  })

  it('lets an explicit host override the catalog route station', async () => {
    const { ctx, calls } = contextOf({
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      base_resp: { status_code: 0 },
    })
    await minimaxAdapter.query({ ...ctx, provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1' })
    expect(calls[0]?.url).toBe('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
  })

  it('matches the catalog routes and both stations', () => {
    expect(minimaxAdapter.matches({ provider: 'minimax-cn' })).toBe(true)
    expect(minimaxAdapter.matches({ provider: 'relay', baseUrl: 'https://api.minimaxi.com/v1' })).toBe(true)
    expect(minimaxAdapter.matches({ provider: 'relay', baseUrl: 'https://api.minimax.io/v4' })).toBe(true)
    expect(minimaxAdapter.matches({ provider: 'minimax', baseUrl: 'https://api.example.com' })).toBe(true)
    expect(minimaxAdapter.matches({ provider: 'other', baseUrl: 'https://api.example.com' })).toBe(false)
  })
})

describe('deepseekBalanceAdapter', () => {
  it('reads the CNY balance entry', async () => {
    const { ctx, calls } = contextOf({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.50' },
        { currency: 'USD', total_balance: '0.00' },
      ],
    })
    const result = await deepseekBalanceAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'balance', remainingValue: 110.5, unit: 'cny' }])
    expect(calls[0]?.url).toBe('https://api.deepseek.com/user/balance')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test')
  })

  it('keeps a negative overdrawn balance (a real unavailable-account response)', async () => {
    const { ctx } = contextOf({
      is_available: false,
      balance_infos: [
        { currency: 'CNY', total_balance: '-0.01', granted_balance: '0.00', topped_up_balance: '-0.01' },
      ],
    })
    const result = await deepseekBalanceAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'balance', remainingValue: -0.01, unit: 'cny' }])
  })

  it('strips a trailing /v1 so the official balance path is not nested under it', async () => {
    const { ctx, calls } = contextOf({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '1.00' }],
    })
    await deepseekBalanceAdapter.query({ ...ctx, baseUrl: 'https://api.deepseek.com/v1/' })
    expect(calls[0]?.url).toBe('https://api.deepseek.com/user/balance')
  })

  it('keeps a proxy path in front of /v1', async () => {
    const { ctx, calls } = contextOf({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '1.00' }],
    })
    await deepseekBalanceAdapter.query({ ...ctx, baseUrl: 'https://gw.example/deepseek/v1' })
    expect(calls[0]?.url).toBe('https://gw.example/deepseek/user/balance')
  })

  it('matches the official route and deepseek hosts', () => {
    expect(deepseekBalanceAdapter.matches({ provider: 'deepseek-official' })).toBe(true)
    expect(deepseekBalanceAdapter.matches({ provider: 'relay', baseUrl: 'https://api.deepseek.com/v1' })).toBe(true)
    expect(deepseekBalanceAdapter.matches({ provider: 'relay', baseUrl: 'https://open.bigmodel.cn' })).toBe(false)
  })

  it('does not claim the signed-in account route even on a deepseek host', () => {
    expect(deepseekBalanceAdapter.matches({
      provider: 'deepseek-account',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })).toBe(false)
  })
})

describe('deepseekAccountAdapter', () => {
  const readerOf = (body: {
    status: 'ready' | 'failed'
    value?: Array<{ currency: string; balance: string }>
    bonusWallets?: Array<{ currency: string; balance: string }>
  } | null) => vi.fn(async () => body)

  it('reads the CNY recharge purse and a positive bonus purse', async () => {
    const readAccountBalance = readerOf({
      status: 'ready',
      value: [
        { currency: 'USD', balance: '1.00' },
        { currency: 'CNY', balance: '110.50' },
      ],
      bonusWallets: [
        { currency: 'CNY', balance: '8.00' },
        { currency: 'USD', balance: '0.00' },
      ],
    })
    const result = await deepseekAccountAdapter.query({
      provider: 'deepseek-account',
      apiKey: '',
      fetchFn: vi.fn(),
      readAccountBalance,
    })
    expect(result.windows).toEqual([
      { tier: 'balance', remainingValue: 110.5, unit: 'cny', balanceKind: 'recharge' },
      { tier: 'balance', remainingValue: 8, unit: 'cny', balanceKind: 'bonus' },
    ])
    expect(readAccountBalance).toHaveBeenCalledTimes(1)
  })

  it('omits a zero bonus purse and keeps a zero recharge purse', async () => {
    const result = await deepseekAccountAdapter.query({
      provider: 'deepseek-account',
      apiKey: '',
      fetchFn: vi.fn(),
      readAccountBalance: readerOf({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '0.00' }],
        bonusWallets: [{ currency: 'CNY', balance: '0.00' }],
      }),
    })
    expect(result.windows).toEqual([
      { tier: 'balance', remainingValue: 0, unit: 'cny', balanceKind: 'recharge' },
    ])
  })

  it('falls back to USD when the purse has no CNY entry', async () => {
    const result = await deepseekAccountAdapter.query({
      provider: 'deepseek-account',
      apiKey: '',
      fetchFn: vi.fn(),
      readAccountBalance: readerOf({
        status: 'ready',
        value: [{ currency: 'USD', balance: '3.25' }],
        bonusWallets: [],
      }),
    })
    expect(result.windows).toEqual([
      { tier: 'balance', remainingValue: 3.25, unit: 'usd', balanceKind: 'recharge' },
    ])
  })

  it('reports signed-out when the host has no reader or the grant is gone', async () => {
    await expect(deepseekAccountAdapter.query({
      provider: 'deepseek-account', apiKey: '', fetchFn: vi.fn(),
    })).rejects.toMatchObject({ kind: 'signed-out' })
    await expect(deepseekAccountAdapter.query({
      provider: 'deepseek-account', apiKey: '', fetchFn: vi.fn(),
      readAccountBalance: readerOf(null),
    })).rejects.toMatchObject({ kind: 'signed-out' })
  })

  it('reports a network failure when the wallet read fails or throws', async () => {
    await expect(deepseekAccountAdapter.query({
      provider: 'deepseek-account', apiKey: '', fetchFn: vi.fn(),
      readAccountBalance: readerOf({ status: 'failed' }),
    })).rejects.toMatchObject({ kind: 'network' })
    await expect(deepseekAccountAdapter.query({
      provider: 'deepseek-account', apiKey: '', fetchFn: vi.fn(),
      readAccountBalance: async () => { throw new Error('socket hang up') },
    })).rejects.toMatchObject({ kind: 'network', message: 'socket hang up' })
  })

  it('matches only the account route key', () => {
    expect(deepseekAccountAdapter.matches({ provider: 'deepseek-account' })).toBe(true)
    expect(deepseekAccountAdapter.matches({
      provider: 'deepseek-account',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })).toBe(true)
    expect(deepseekAccountAdapter.matches({ provider: 'deepseek-official' })).toBe(false)
    expect(deepseekAccountAdapter.matches({
      provider: 'relay',
      baseUrl: 'https://api.deepseek.com/v1',
    })).toBe(false)
  })
})

describe('openrouterAdapter', () => {
  it('derives remaining credits and the spend total', async () => {
    const { ctx, calls } = contextOf({ data: { total_credits: 10, total_usage: 3.2 } })
    const result = await openrouterAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'balance', remainingValue: 6.8, maxValue: 10, unit: 'usd' }])
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/credits')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test')
  })

  it('parses string amounts as the live API can ship them', async () => {
    const { ctx } = contextOf({ data: { total_credits: '10', total_usage: '3.2' } })
    const result = await openrouterAdapter.query(ctx)
    expect(result.windows).toEqual([{ tier: 'balance', remainingValue: 6.8, maxValue: 10, unit: 'usd' }])
  })

  it('matches the openrouter route and host', () => {
    expect(openrouterAdapter.matches({ provider: 'openrouter' })).toBe(true)
    expect(openrouterAdapter.matches({ provider: 'relay', baseUrl: 'https://openrouter.ai/api/v1' })).toBe(true)
    expect(openrouterAdapter.matches({ provider: 'relay', baseUrl: 'https://api.openai.com/v1' })).toBe(false)
  })
})

describe('opencodeGoAdapter', () => {
  it('maps rolling/weekly/monthly used percents and ISO reset times (a live response)', async () => {
    const { ctx, calls } = contextOf({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-26T06:33:21.904Z' },
        weekly: { status: 'ok', percent: 0, resetsAt: '2026-08-31T00:00:00.904Z' },
        monthly: { status: 'ok', percent: 39, resetsAt: '2026-09-13T01:39:58.904Z' },
      },
    })
    const result = await opencodeGoAdapter.query(ctx)
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 0, resetAt: Date.parse('2026-08-26T06:33:21.904Z') },
      { tier: 'weekly', usedPercent: 0, resetAt: Date.parse('2026-08-31T00:00:00.904Z') },
      { tier: 'monthly', usedPercent: 39, resetAt: Date.parse('2026-09-13T01:39:58.904Z') },
    ])
    expect(calls[0]?.url).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test')
  })

  it('skips a lane with no percent and still returns the others', async () => {
    const { ctx } = contextOf({
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: '2026-08-26T06:33:21.904Z' },
        weekly: { status: 'ok' },
        monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-13T01:39:58.904Z' },
      },
    })
    const result = await opencodeGoAdapter.query(ctx)
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 12, resetAt: Date.parse('2026-08-26T06:33:21.904Z') },
      { tier: 'monthly', usedPercent: 100, resetAt: Date.parse('2026-09-13T01:39:58.904Z') },
    ])
  })

  it('normalizes 401 into auth and rejects a body without usage', async () => {
    const authed = contextOf({ message: 'unauthorized' }, 401)
    await expect(opencodeGoAdapter.query(authed.ctx)).rejects.toMatchObject({ kind: 'auth' })
    const malformed = contextOf({ unexpected: true })
    await expect(opencodeGoAdapter.query(malformed.ctx)).rejects.toMatchObject({
      kind: 'parse',
      message: 'missing "usage" object',
    })
  })

  it('matches the catalog route and /zen/go hosts, not Zen pay-as-you-go', () => {
    expect(opencodeGoAdapter.matches({ provider: 'opencode-go' })).toBe(true)
    expect(opencodeGoAdapter.matches({ provider: 'relay', baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(true)
    expect(opencodeGoAdapter.matches({ provider: 'opencode', baseUrl: 'https://opencode.ai/zen/v1' })).toBe(false)
    expect(opencodeGoAdapter.matches({ provider: 'opencode' })).toBe(false)
  })
})

describe('commandCodeAdapter', () => {
  /** The four live endpoints of a limited GOAT account (shapes from the
   * cc-switch implementation; figures are synthetic). */
  const goatRoutes = [
    { match: '/alpha/whoami', body: { org: { id: 'org_9f3k' } } },
    {
      match: '/alpha/billing/credits',
      body: {
        credits: { monthlyCredits: 30, purchasedCredits: 5, freeCredits: 0 },
        windowLimits: {
          limited: true,
          fiveHour: { used: 7, cap: 14, resetAt: 1_791_800_000_000 },
          weekly: { used: 3.5, cap: 35, resetAt: 1_792_300_000_000 },
        },
      },
    },
    {
      match: '/alpha/billing/subscriptions',
      body: {
        success: true,
        data: {
          planId: 'individual-goat',
          status: 'active',
          currentPeriodStart: '2026-10-01T00:00:00.000Z',
          currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        },
      },
    },
    { match: '/alpha/usage/summary', body: { totalCost: 15 } },
  ]

  it('maps the window lanes and derives the monthly pool from credits + spend', async () => {
    const { ctx, calls } = contextOfRoutes(goatRoutes)
    const result = await commandCodeAdapter.query(ctx)
    // 7/14 = 50%, 3.5/35 = 10%, and 15 / (15 + 30 + 5 + 0) = 30%.
    expect(result.windows).toEqual([
      { tier: 'five_hour', usedPercent: 50, resetAt: 1_791_800_000_000 },
      { tier: 'weekly', usedPercent: 10, resetAt: 1_792_300_000_000 },
      { tier: 'monthly', usedPercent: 30, resetAt: Date.parse('2026-11-01T00:00:00.000Z') },
    ])
    expect(result.planTier).toBe('GOAT')
    expect(calls).toHaveLength(4)
    expect(calls[0]?.url).toBe('https://api.commandcode.ai/alpha/whoami?limits=1')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test')
    expect(calls[1]?.url).toBe('https://api.commandcode.ai/alpha/billing/credits?orgId=org_9f3k')
    expect(calls[2]?.url).toBe('https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_9f3k')
    expect(calls[3]?.url).toBe(`https://api.commandcode.ai/alpha/usage/summary?since=${encodeURIComponent('2026-10-01T00:00:00.000Z')}&orgId=org_9f3k`)
  })

  it('keeps querying account-scoped when whoami fails, and surfaces a dead key as auth', async () => {
    const scoped = contextOfRoutes([{ match: '/alpha/whoami', status: 500 }, ...goatRoutes.slice(1)])
    const result = await commandCodeAdapter.query(scoped.ctx)
    expect(result.windows).toHaveLength(3)
    expect(scoped.calls[1]?.url).toBe('https://api.commandcode.ai/alpha/billing/credits')

    const dead = contextOfRoutes([{ match: '/alpha/whoami', status: 401, body: { message: 'unauthorized' } }])
    await expect(commandCodeAdapter.query(dead.ctx)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('paints only the monthly window when the plan is not window-limited', async () => {
    const { ctx } = contextOfRoutes([
      goatRoutes[0]!,
      { match: '/alpha/billing/credits', body: { credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 } } },
      goatRoutes[2]!,
      { match: '/alpha/usage/summary', body: { totalCost: 70 } },
    ])
    const result = await commandCodeAdapter.query(ctx)
    // No `windowLimits` at all — 70 / (70 + 70) = 50% of the period pool.
    expect(result.windows).toEqual([{ tier: 'monthly', usedPercent: 50, resetAt: Date.parse('2026-11-01T00:00:00.000Z') }])
  })

  it('accepts the nested windowLimits spelling and ignores lanes while unlimited', async () => {
    const { ctx } = contextOfRoutes([
      goatRoutes[0]!,
      {
        match: '/alpha/billing/credits',
        body: {
          credits: {
            monthlyCredits: 10,
            windowLimits: { limited: false, fiveHour: { used: 1, cap: 10, resetAt: 1_791_800_000_000 } },
          },
        },
      },
      goatRoutes[2]!,
      { match: '/alpha/usage/summary', body: { totalCost: 5 } },
    ])
    const result = await commandCodeAdapter.query(ctx)
    // limited: false — the fiveHour lane must NOT paint; 5 / (5 + 10) = 33.3%.
    expect(result.windows).toEqual([{ tier: 'monthly', usedPercent: (5 / 15) * 100, resetAt: Date.parse('2026-11-01T00:00:00.000Z') }])
  })

  it('falls back to credits.planId and shows an unknown plan id verbatim', async () => {
    const { ctx } = contextOfRoutes([
      goatRoutes[0]!,
      { match: '/alpha/billing/credits', body: { credits: { monthlyCredits: 10, planId: 'individual-future' } } },
      { match: '/alpha/billing/subscriptions', body: { success: true, data: { status: 'active' } } },
      { match: '/alpha/usage/summary', body: { totalCost: 0 } },
    ])
    const result = await commandCodeAdapter.query(ctx)
    expect(result.planTier).toBe('individual-future')
    // 0 / (0 + 10) — a fresh period paints 0%; no period end, no reset.
    expect(result.windows).toEqual([{ tier: 'monthly', usedPercent: 0 }])
  })

  it('rejects bodies without the credits object or the spend total, and normalizes 401', async () => {
    const creditless = contextOfRoutes([{ match: '/alpha/billing/credits', body: { windowLimits: { limited: true } } }])
    await expect(commandCodeAdapter.query(creditless.ctx)).rejects.toMatchObject({
      kind: 'parse',
      message: 'missing "credits" object',
    })

    const spendless = contextOfRoutes([
      goatRoutes[0]!,
      { match: '/alpha/billing/credits', body: { credits: { monthlyCredits: 10 } } },
      goatRoutes[2]!,
      { match: '/alpha/usage/summary', body: { totals: {} } },
    ])
    await expect(commandCodeAdapter.query(spendless.ctx)).rejects.toMatchObject({
      kind: 'parse',
      message: 'missing "totalCost" number',
    })

    const authed = contextOfRoutes([{ match: '/alpha/billing/credits', status: 401, body: { message: 'unauthorized' } }])
    await expect(commandCodeAdapter.query(authed.ctx)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('matches commandcode hosts only — the route key carries no catalog identity', () => {
    expect(commandCodeAdapter.matches({ provider: 'my-gateway', baseUrl: 'https://api.commandcode.ai/provider/v1' })).toBe(true)
    expect(commandCodeAdapter.matches({ provider: 'my-gateway', baseUrl: 'https://api.commandcode.ai/provider' })).toBe(true)
    // pi-ai's catalog ships no Command Code route, so a bare name claims
    // nothing (even the issue's suggested "command-code") — the base URL
    // host is the only stable signal on a user-declared route.
    expect(commandCodeAdapter.matches({ provider: 'command-code' })).toBe(false)
    expect(commandCodeAdapter.matches({ provider: 'commandcode' })).toBe(false)
    expect(commandCodeAdapter.matches({ provider: 'command', baseUrl: 'https://api.example.com/v1' })).toBe(false)
    expect(commandCodeAdapter.matches({ provider: 'relay', baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(false)
  })
})

/** The magpie quota report fixture: one subscription (windows in percent),
 * one key-bought plan, one API-key balance — the report shape the
 * gateway's `GET /v1/magpie/quotas` answers (see magpie's provider.Quota). */
const MAGPIE_REPORT = {
  object: 'list',
  data: [
    {
      provider: 'zcode', name: 'ZCode', kind: 'subscription', plan: 'GLM Coding Lite', user: 'ZCode',
      windows: [
        { name: '5 hours', used: 100, remaining: 0, resetsAt: '2026-10-25T03:20:04Z', display: '2000 / 2000' },
        { name: 'Weekly', used: 66.97, remaining: 33.03, resetsAt: '2026-10-30T07:07:49Z', display: '6697 / 10000' },
      ],
      readAt: '2026-10-25T10:54:21+08:00',
    },
    {
      provider: 'stepfun', name: 'StepFun', kind: 'plan', plan: 'Pro', user: '',
      windows: [{ name: 'Credits', used: 13, resetsAt: '2026-11-01T00:00:00Z' }],
      readAt: '2026-10-25T10:54:22+08:00',
    },
    {
      provider: 'deepseek', name: 'DeepSeek', kind: 'balance', windows: [], balance: '¥356.81',
      readAt: '2026-10-25T10:54:23+08:00',
    },
  ],
}

/** A magpie query context over a stub transport; `calls` records the
 * request shape, and the context carries the gateway base URL and the
 * asking model the way the service injects them. */
function magpieContextOf(
  body: unknown,
  overrides: { baseUrl?: string; model?: string; apiKey?: string; status?: number } = {},
): { ctx: QuotaQueryContext; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify(body), {
      status: overrides.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return {
    ctx: {
      provider: 'magpie',
      baseUrl: overrides.baseUrl ?? 'http://127.0.0.1:3425/v1',
      apiKey: overrides.apiKey ?? '',
      ...(overrides.model !== undefined ? { model: overrides.model } : {}),
      fetchFn,
    },
    calls,
  }
}

describe('magpieAdapter', () => {
  it('normalizes the report: period windows, open-named windows, balances', async () => {
    const { ctx } = magpieContextOf(MAGPIE_REPORT, { model: 'zcode/glm-4.7' })
    const result = await magpieAdapter.query(ctx)
    expect(result.windows).toEqual([
      {
        tier: 'five_hour', usedPercent: 100, resetAt: Date.parse('2026-10-25T03:20:04Z'),
        card: 'ZCode · GLM Coding Lite',
      },
      {
        tier: 'weekly', usedPercent: 66.97, resetAt: Date.parse('2026-10-30T07:07:49Z'),
        card: 'ZCode · GLM Coding Lite',
      },
    ])
  })

  it('scopes by the model prefix, falls back to the fleet for groups and bare ids', async () => {
    // A model of the plan-carrying provider: the open-named window rides
    // as `other` with the vendor's own name.
    const scoped = await magpieAdapter.query(magpieContextOf(MAGPIE_REPORT, { model: 'stepfun/step-3' }).ctx)
    expect(scoped.windows).toEqual([
      { tier: 'other', usedPercent: 13, resetAt: Date.parse('2026-11-01T00:00:00Z'), name: 'Credits', card: 'StepFun · Pro' },
    ])

    // A routing group id scopes to nothing the REST API can name: the
    // whole fleet answers, cards distinguished by their titles.
    const fleet = await magpieAdapter.query(magpieContextOf(MAGPIE_REPORT, { model: 'group/quick' }).ctx)
    expect(fleet.windows.map(w => w.card)).toEqual([
      'ZCode · GLM Coding Lite', 'ZCode · GLM Coding Lite', 'StepFun · Pro', 'DeepSeek',
    ])
    expect(fleet.windows[3]).toEqual({ tier: 'balance', remainingValue: 356.81, unit: 'cny', card: 'DeepSeek' })

    // A bare id (the gateway's bare-ids setting) has no prefix either.
    const bare = await magpieAdapter.query(magpieContextOf(MAGPIE_REPORT, { model: 'glm-4.7' }).ctx)
    expect(bare.windows.length).toBe(4)
  })

  it('parses the first money amount of multi-currency balances and skips money-less cards', async () => {
    const report = {
      object: 'list',
      data: [
        { provider: 'ds', name: 'DS', kind: 'balance', windows: [], balance: '$11.12 · ¥-0.05' },
        { provider: 'sf', name: 'SF', kind: 'balance', windows: [], balance: '12.3k credits' },
      ],
    }
    const result = await magpieAdapter.query(magpieContextOf(report).ctx)
    expect(result.windows).toEqual([{ tier: 'balance', remainingValue: 11.12, unit: 'usd', card: 'DS' }])
  })

  it('qualifies same-provider cards by account and numbers blank ones', async () => {
    const report = {
      object: 'list',
      data: [
        { provider: 'codex', name: 'Codex', kind: 'subscription', user: 'me@example.com', windows: [{ name: '5 hours', used: 40 }] },
        { provider: 'codex', name: 'Codex', kind: 'subscription', windows: [{ name: '5 hours', used: 5 }] },
      ],
    }
    const result = await magpieAdapter.query(magpieContextOf(report, { model: 'codex/gpt-5.5' }).ctx)
    expect(result.windows.map(w => w.card)).toEqual([
      'Codex · me@example.com', 'Codex · #1',
    ])
  })

  it('drops failed cards while any healthy one remains, surfaces an all-error report', async () => {
    const mixed = {
      object: 'list',
      data: [
        { provider: 'claude', name: 'Claude', kind: 'subscription', windows: [], error: 'session expired' },
        ...MAGPIE_REPORT.data.slice(0, 1),
      ],
    }
    const healthy = await magpieAdapter.query(magpieContextOf(mixed).ctx)
    expect(healthy.windows.every(w => w.card?.startsWith('ZCode') === true)).toBe(true)

    const allError = {
      object: 'list',
      data: [{ provider: 'claude', name: 'Claude', kind: 'subscription', windows: [], error: 'session expired' }],
    }
    await expect(magpieAdapter.query(magpieContextOf(allError).ctx)).rejects.toMatchObject({
      kind: 'http',
      message: 'session expired',
    })
  })

  it('appends the endpoint under both base-URL spellings and sends the key when one exists', async () => {
    const v1 = magpieContextOf(MAGPIE_REPORT, { apiKey: 'gw-key' })
    await magpieAdapter.query(v1.ctx)
    expect(v1.calls[0]?.url).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
    expect(v1.calls[0]?.headers.authorization).toBe('Bearer gw-key')

    const bare = magpieContextOf(MAGPIE_REPORT, { baseUrl: 'http://127.0.0.1:3425/' })
    await magpieAdapter.query(bare.ctx)
    expect(bare.calls[0]?.url).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
    expect(bare.calls[0]?.headers.authorization).toBeUndefined()
  })

  it('never falls back to a live vendor read when the kept report is empty or failed', async () => {
    for (const report of [{ object: 'list', data: [] }, { object: 'list', data: [
      { provider: 'zcode', name: 'ZCode', error: 'not read yet' },
    ] }]) {
      const { ctx, calls } = magpieContextOf(report)
      await expect(magpieAdapter.query(ctx)).rejects.toBeInstanceOf(QuotaQueryError)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
    }
  })

  it('claims only its route key and raises the query deadline over the relay', () => {
    expect(magpieAdapter.usesApiKey).toBe(false)
    expect(magpieAdapter.queryTimeoutMs).toBe(15_000)
    expect(magpieAdapter.matches({ provider: 'magpie' })).toBe(true)
    // Any other name waits for the hello probe — a loopback host is not
    // evidence of magpie (other local gateways live there too).
    expect(magpieAdapter.matches({ provider: 'my-gateway', baseUrl: 'http://127.0.0.1:3425/v1' })).toBe(false)
    expect(magpieAdapter.matches({ provider: 'my-gateway' })).toBe(false)
  })
})

describe('magpieQuotaUrl', () => {
  it('normalizes every base-URL spelling onto the report endpoint', () => {
    expect(magpieQuotaUrl('http://127.0.0.1:3425/v1')).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
    expect(magpieQuotaUrl('http://127.0.0.1:3425/v1/')).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
    expect(magpieQuotaUrl('http://127.0.0.1:3425')).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
    expect(magpieQuotaUrl('http://192.168.1.9:5000/v1')).toBe('http://192.168.1.9:5000/v1/magpie/quotas?kept=1')
    // No profile base URL at all: the gateway's default listen address.
    expect(magpieQuotaUrl(undefined)).toBe('http://127.0.0.1:3425/v1/magpie/quotas?kept=1')
  })
})

describe('MagpieDetector', () => {
  it('recognizes the hello and caches both verdicts off the hot path', async () => {
    let at = 1_000_000
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      const body = href.includes('not-magpie')
        ? { object: 'list', data: [] }
        : { name: 'magpie' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const detector = new MagpieDetector(() => at)

    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:3425/v1', fetchFn })).toBe(true)
    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:3425/v1/', fetchFn })).toBe(true) // same cache key
    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:9999/not-magpie/v1', fetchFn })).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)

    // Both verdicts hold inside their TTLs…
    at += MagpieDetector.MISS_TTL_MS - 1
    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:3425/v1', fetchFn })).toBe(true)
    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:9999/not-magpie/v1', fetchFn })).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)

    // …and re-probe once each expires (a gateway that came up between
    // polls is found on the next one).
    at += 2
    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:9999/not-magpie/v1', fetchFn })).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('treats a transport failure as not-magpie rather than throwing', async () => {
    const dead = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const detector = new MagpieDetector()
    expect(await detector.detect({ baseUrl: 'http://127.0.0.1:3425/v1', fetchFn: dead })).toBe(false)
  })

  it('sends the gateway key with the hello when one is given', async () => {
    const calls: Array<Record<string, string>> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>)
      return new Response(JSON.stringify({ name: 'magpie' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await new MagpieDetector().detect({ baseUrl: 'http://192.168.1.9:5000/v1', apiKey: 'gw-key', fetchFn })
    expect(calls[0]?.authorization).toBe('Bearer gw-key')
  })
})
