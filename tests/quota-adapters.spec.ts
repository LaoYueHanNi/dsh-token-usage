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
import { deepseekBalanceAdapter } from '../src/quota/adapters/deepseek-balance.ts'
import { kimiAdapter } from '../src/quota/adapters/kimi.ts'
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
