// @vitest-environment jsdom
/**
 * Pricing-overview dialog component tests: the family sort and search
 * predicates as pure functions, then the rendered dialog over a stubbed
 * fetch — the flat family-sorted list, the used tag, the token-bucket
 * inputs with their K/M/B units, case fill, and un-press, CNY / USD rate
 * columns, search filtering, the failure state with its retry, and the
 * stacked detail dialog's close events (Esc's event-level stand-in:
 * closing the top dialog never touches the overview beneath).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  hitNodeOf,
  matchesPricingSearch,
  PricingOverviewDialog,
  sortPricingModels,
} from '../src/client/PricingOverviewDialog.tsx'
import { zh } from '../src/client/locales.ts'
import type { ModelRates, PricingOverviewModel, PricingOverviewPayload } from '../src/wire.ts'

/** Common-namespace zh values the tests assert against (shell-owned copy). */
const COMMON_ZH: Record<string, string> = {
  loading: '加载中…',
  retry: '重试',
}

/**
 * zh-bound translate stub: renders the same copy the tests were written on,
 * with `{name}` template substitution like the real lookup chain.
 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? COMMON_ZH[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** Full base rates (¥/M): all four prices present. */
const RATES: ModelRates = {
  base: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1, cacheWritePerMillion: 4 },
  contextTiers: [],
  dailySlots: [],
  timeRules: [],
}

/** No cache prices: the simulated cost falls back to the input rate. */
const NO_CACHE_RATES: ModelRates = {
  base: { inputPerMillion: 1, outputPerMillion: 2 },
  contextTiers: [],
  dailySlots: [],
  timeRules: [],
}

/** Cheap variant so the simulated-cost sort has three distinct tiers. */
const CHEAP_RATES: ModelRates = {
  base: { inputPerMillion: 0.5, outputPerMillion: 1 },
  contextTiers: [],
  dailySlots: [],
  timeRules: [],
}

/** Both time rules long expired: the root world (base + its peak slot)
 * is effective. The slot row shows regardless of the current minute. */
const V4_PRO_RATES: ModelRates = {
  base: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 },
  contextTiers: [],
  dailySlots: [{
    label: '高峰时段',
    windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
    rates: { inputPerMillion: 9, outputPerMillion: 27, cacheReadPerMillion: 0.3 },
  }],
  timeRules: [
    { startTime: 0, endTime: 1, rates: { inputPerMillion: 12, outputPerMillion: 24, cacheReadPerMillion: 0.1 } },
    { label: '第一次长期降价', startTime: 2, endTime: 3, rates: { inputPerMillion: 3, outputPerMillion: 6, cacheReadPerMillion: 0.025 } },
  ],
}

/** A time rule whose window reaches far into the future: its default
 * rates ARE the main row — the root's prices never show, and with no
 * slots/tiers on the rule there are no special rows (no arrow). */
const GEMINI_RATES: ModelRates = {
  base: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1 },
  contextTiers: [],
  dailySlots: [],
  timeRules: [
    { label: '限时优惠价', startTime: 0, endTime: 4_102_444_800, rates: { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 } },
  ],
}

/** A root context tier, no rules: the root world with a tier row when the
 * scenario's input side clears the threshold. */
const MINIMAX_RATES: ModelRates = {
  base: { inputPerMillion: 2.1, outputPerMillion: 8.4, cacheReadPerMillion: 0.42 },
  contextTiers: [{ threshold: 512_000, rates: { inputPerMillion: 4.2, outputPerMillion: 16.8, cacheReadPerMillion: 0.84 } }],
  dailySlots: [],
  timeRules: [],
}

const MODELS: PricingOverviewModel[] = [
  { modelId: 'glm-4.7', aliases: ['glm', 'chatglm'], family: 'glm', rules: RATES },
  { modelId: 'glm-4.6', aliases: [], family: 'glm', rules: CHEAP_RATES },
  { modelId: 'deepseek-chat', aliases: ['dsv3'], family: 'deepseek', rules: RATES },
  // No family on the wire: lands in the feed's own `other` bucket.
  { modelId: 'kimi-k2', aliases: ['moonshot', 'kimi', 'm2'], rules: NO_CACHE_RATES },
  { modelId: 'deepseek-v4-pro', aliases: [], family: 'deepseek', rules: V4_PRO_RATES },
  { modelId: 'gemini-3.7-flash', aliases: [], family: 'gemini', rules: GEMINI_RATES },
  { modelId: 'MiniMax-M3', aliases: [], family: 'minimax', rules: MINIMAX_RATES },
]

const OVERVIEW: PricingOverviewPayload = {
  models: MODELS,
  currency: 'CNY',
  usdExchangeRate: 7,
}

/** The open-time used-model snapshot: only the deepseek model is in use. */
const USED = new Set(['deepseek-chat'])

function stubFetch(impl: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

// jsdom ships no dialog methods; stub the pair showModal/close so the
// dialogs behave like a browser (close fires the `close` event the
// components' onClose listeners react to — the event-level stand-in for
// the Esc key, which jsdom does not synthesize).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the dialog over a ready overview; resolves once the table shows. */
async function renderReady(payload: PricingOverviewPayload = OVERVIEW) {
  const urls: string[] = []
  stubFetch(async (input: string | URL | Request) => {
    urls.push(String(input))
    return { ok: true, json: async () => payload }
  })
  const onClose = vi.fn()
  render(<PricingOverviewDialog usedModels={USED} view={{ symbol: '￥', rate: 1 }} onClose={onClose} t={t} />)
  const dialog = await screen.findByRole('dialog', { name: '定价表' })
  await within(dialog).findByText('deepseek-chat')
  return { dialog, onClose, urls }
}

describe('hitNodeOf', () => {
  it('picks the rule whose date window contains now; expired rules fall back to the root', () => {
    const nowSec = 2.5
    // Window [0, 1] is past, [2, 3] contains 2.5s → the discount rule owns
    // the present: its rates are the main row, the root slot does not leak.
    const node = hitNodeOf(V4_PRO_RATES, 100_000_000, nowSec * 1000)
    expect(node.baseRates).toEqual(V4_PRO_RATES.timeRules[1]!.rates)
    expect(node.slots).toEqual([])
    expect(node.tier).toBeUndefined()
    // Outside every rule → the root world: base prices + the root slot.
    const root = hitNodeOf(V4_PRO_RATES, 100_000_000, 10 * 1000)
    expect(root.baseRates).toEqual(V4_PRO_RATES.base)
    expect(root.slots).toEqual(V4_PRO_RATES.dailySlots)
  })

  it('hits the largest context tier the input side clears', () => {
    const rules: ModelRates = {
      base: { inputPerMillion: 1, outputPerMillion: 1 },
      contextTiers: [
        { threshold: 128_000, rates: { inputPerMillion: 2, outputPerMillion: 2 } },
        { threshold: 512_000, rates: { inputPerMillion: 4, outputPerMillion: 4 } },
      ],
      dailySlots: [],
      timeRules: [],
    }
    expect(hitNodeOf(rules, 100_000, 0)!.tier).toBeUndefined()
    expect(hitNodeOf(rules, 512_000, 0)!.tier).toEqual(rules.contextTiers[1])
    expect(hitNodeOf(rules, 600_000, 0)!.tier).toEqual(rules.contextTiers[1])
    expect(hitNodeOf(rules, 200_000, 0)!.tier).toEqual(rules.contextTiers[0])
  })
})

describe('sortPricingModels', () => {
  it('sorts by family (absent lands in other, last) then by modelId', () => {
    const sorted = sortPricingModels(MODELS)
    expect(sorted.map(model => model.modelId)).toEqual([
      'deepseek-chat', 'deepseek-v4-pro', 'gemini-3.7-flash', 'glm-4.6', 'glm-4.7', 'MiniMax-M3', 'kimi-k2',
    ])
  })
})

describe('matchesPricingSearch', () => {
  it('matches everything on an empty query', () => {
    expect(matchesPricingSearch(MODELS[0]!, '')).toBe(true)
  })

  it('hits the modelId, an alias, or the family, case-insensitively', () => {
    expect(matchesPricingSearch(MODELS[0]!, 'LM-4')).toBe(true)
    expect(matchesPricingSearch(MODELS[0]!, 'ChatGLM')).toBe(true)
    expect(matchesPricingSearch(MODELS[0]!, 'GLM')).toBe(true)
    // The family-less model lands in `other`; only the family matches here.
    expect(matchesPricingSearch(MODELS[3]!, 'other')).toBe(true)
    expect(matchesPricingSearch(MODELS[0]!, 'qwen')).toBe(false)
  })
})

describe('PricingOverviewDialog', () => {
  it('fetches the pricing route with no query and renders the flat family-sorted list', async () => {
    const { dialog, urls } = await renderReady()
    // One overview fetch, filter-free by contract.
    expect(urls).toEqual(['/token-usage/pricing'])
    expect((dialog as HTMLDialogElement).open).toBe(true)
    // A flat list in (family, modelId) order — deepseek < gemini < glm <
    // minimax < other, with no group heads and nothing folded.
    const ids = ['deepseek-chat', 'deepseek-v4-pro', 'gemini-3.7-flash', 'glm-4.6', 'glm-4.7', 'MiniMax-M3', 'kimi-k2']
    const order = ids.map(id => dialog.textContent!.indexOf(id))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const id of ids) {
      expect(within(dialog).getByText(id)).toBeTruthy()
    }
  })

  it('tags used rows; every row is directly visible without folding', async () => {
    const { dialog } = await renderReady()
    const row = within(dialog).getByRole('button', { name: '查看 deepseek-chat 定价' })
    expect(within(row).getByText('已用')).toBeTruthy()
    // Unused rows render just the same — no grouping to hide behind.
    expect(within(dialog).getByText('kimi-k2')).toBeTruthy()
  })

  it('never renders aliases — they are a search dimension only', async () => {
    const { dialog } = await renderReady()
    expect(within(dialog).getByText('kimi-k2')).toBeTruthy()
    for (const alias of ['moonshot、kimi +1', 'moonshot', 'chatglm', 'dsv3']) {
      expect(within(dialog).queryByText(alias)).toBeNull()
    }
  })

  it('prefills the buckets compact (2M / 98M / 457K / 0) with the case pressed', async () => {
    const { dialog } = await renderReady()
    const button = within(dialog).getByRole('button', { name: '案例1' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    // The refill is compact: an amount under a fitting unit, not raw token
    // counts (2 / 98 in M, 457 / 0 in K).
    const bucket = (name: string) => within(dialog).getByLabelText(name) as HTMLInputElement
    expect(bucket('输入').value).toBe('2')
    expect(bucket('缓存读').value).toBe('98')
    expect(bucket('输出').value).toBe('457')
    expect(bucket('缓存写').value).toBe('0')
    const unit = (name: string) => within(dialog).getByRole('button', { name })
    expect(unit('输入（M）').getAttribute('aria-pressed')).toBe('true')
    expect(unit('缓存读（M）').getAttribute('aria-pressed')).toBe('true')
    expect(unit('输出（K）').getAttribute('aria-pressed')).toBe('true')
    // The hover title keeps the workload picture.
    expect(button.title).toBe('输入 100M（缓存 98%） 输出 457K')
  })

  it('fills the buckets from the case button; a manual edit un-presses it', async () => {
    const { dialog } = await renderReady()
    const row = within(dialog).getByRole('button', { name: '查看 deepseek-chat 定价' })
    const button = within(dialog).getByRole('button', { name: '案例1' })
    // A manual edit recalculates (¥2/8/1/4: 2M×2 + 98M×1 + 1000K×8 =
    // ¥110.00) and the button stops reading pressed — the highlight tracks
    // the buckets, not the last click.
    fireEvent.change(within(dialog).getByLabelText('输出'), { target: { value: '1000' } })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(within(row).getByText('110.00￥')).toBeTruthy()
    // The button refills every bucket compact: back to 457K, re-pressed,
    // and the cost returns to ¥105.66.
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect((within(dialog).getByLabelText('输出') as HTMLInputElement).value).toBe('457')
    expect(within(row).getByText('105.66￥')).toBeTruthy()
  })

  it('fills the second case (95% hit, 600K out); the press follows the switch', async () => {
    const { dialog } = await renderReady()
    const first = within(dialog).getByRole('button', { name: '案例1' })
    const second = within(dialog).getByRole('button', { name: '案例2' })
    expect(second.getAttribute('aria-pressed')).toBe('false')
    // The hover title derives from the buckets: input-side total 100M at
    // 95% cache hit, 600K output.
    expect(second.title).toBe('输入 100M（缓存 95%） 输出 600K')
    // Filling the case moves the press to it and refills the buckets
    // compact: 5M fresh + 95M cache read (the 95% split of 100M), 600K out.
    fireEvent.click(second)
    expect(second.getAttribute('aria-pressed')).toBe('true')
    expect(first.getAttribute('aria-pressed')).toBe('false')
    const bucket = (name: string) => within(dialog).getByLabelText(name) as HTMLInputElement
    expect(bucket('输入').value).toBe('5')
    expect(bucket('缓存读').value).toBe('95')
    expect(bucket('输出').value).toBe('600')
    expect(bucket('缓存写').value).toBe('0')
    // Full rates (¥2/8/1/4): 5M×2 + 95M×1 + 600K×8 = ¥109.80.
    const row = within(dialog).getByRole('button', { name: '查看 deepseek-chat 定价' })
    expect(within(row).getByText('109.80￥')).toBeTruthy()
  })

  it('fills the third case (translation, no cache); the press follows the switch', async () => {
    const { dialog } = await renderReady()
    const third = within(dialog).getByRole('button', { name: '案例3' })
    // The translation case's picture: a 100M input side with zero cache
    // hit, a roughly equal output.
    expect(third.title).toBe('输入 100M（缓存 0%） 输出 100M')
    fireEvent.click(third)
    expect(third.getAttribute('aria-pressed')).toBe('true')
    const bucket = (name: string) => within(dialog).getByLabelText(name) as HTMLInputElement
    expect(bucket('输入').value).toBe('100')
    expect(bucket('缓存读').value).toBe('0')
    expect(bucket('输出').value).toBe('100')
    expect(bucket('缓存写').value).toBe('0')
    // Full rates (¥2/8/1/4), nothing cached: 100M×2 + 100M×8 = ¥1000.00.
    const row = within(dialog).getByRole('button', { name: '查看 deepseek-chat 定价' })
    expect(within(row).getByText('1000.00￥')).toBeTruthy()
  })

  it('switching a bucket unit converts the amount, keeping the tokens', async () => {
    const { dialog } = await renderReady()
    // 98M → K reads 98000K: the amount converts, the token count — and so
    // the costs and the pressed case — stands still.
    fireEvent.click(within(dialog).getByRole('button', { name: '缓存读（K）' }))
    expect((within(dialog).getByLabelText('缓存读') as HTMLInputElement).value).toBe('98000')
    expect(within(dialog).getByRole('button', { name: '案例1' }).getAttribute('aria-pressed')).toBe('true')
    const row = within(dialog).getByRole('button', { name: '查看 kimi-k2 定价' })
    expect(within(row).getByText('100.91￥')).toBeTruthy()
    // Further up to B: 98000K reads 0.098B — same tokens again.
    fireEvent.click(within(dialog).getByRole('button', { name: '缓存读（B）' }))
    expect((within(dialog).getByLabelText('缓存读') as HTMLInputElement).value).toBe('0.098')
    expect(within(row).getByText('100.91￥')).toBeTruthy()
  })

  it('bills the simulated cost per model, cache rates falling back to input', async () => {
    const { dialog } = await renderReady()
    // Scenario: 2M in + 98M cacheRead + 457K out.
    // Full rates (¥2/8/1/4): 4 + 3.656 + 98 = ¥105.66.
    const full = within(dialog).getByRole('button', { name: '查看 deepseek-chat 定价' })
    expect(within(full).getByText('105.66￥')).toBeTruthy()
    // No cache rates (¥1/2): cacheRead bills at the input rate —
    // 2 + 0.914 + 98 = ¥100.91, not the no-fallback ¥2.91.
    const fallback = within(dialog).getByRole('button', { name: '查看 kimi-k2 定价' })
    expect(within(fallback).getByText('100.91￥')).toBeTruthy()
    // Cheap rates (¥0.5/1, fallback): 1 + 0.457 + 49 = ¥50.46.
    const cheap = within(dialog).getByRole('button', { name: '查看 glm-4.6 定价' })
    expect(within(cheap).getByText('50.46￥')).toBeTruthy()
  })

  it('cycles the simulated-cost sort family → desc → asc → family, search keeps the order', async () => {
    const { dialog } = await renderReady()
    // The order of the given ids in the rendered dialog, ascending positions.
    const orderOf = (ids: string[]) => {
      const positions = ids.map(id => dialog.textContent!.indexOf(id))
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    }
    const head = () => within(dialog).getByRole('button', { name: /模拟费用/ })
    // The header always carries a direction glyph — even the default family
    // order shows a dim ⇅, so the column reads as sortable before the first
    // click.
    // Default: family order (deepseek < gemini < glm < minimax < other).
    expect(head().textContent).toBe('模拟费用 ⇅')
    orderOf(['deepseek-chat', 'deepseek-v4-pro', 'gemini-3.7-flash', 'glm-4.6', 'glm-4.7', 'MiniMax-M3', 'kimi-k2'])
    // Click 1: cost desc — the ¥105.66 pair first (equal costs keep family
    // order), then ¥100.91, ¥50.46, ¥49.20, ¥30.87, ¥12.71. The sort keys
    // are effective-main-row costs: gemini sits on its discount rule.
    fireEvent.click(head())
    expect(head().textContent).toBe('模拟费用 ▾')
    orderOf(['deepseek-chat', 'glm-4.7', 'kimi-k2', 'glm-4.6', 'MiniMax-M3', 'deepseek-v4-pro', 'gemini-3.7-flash'])
    // A search while cost-sorted filters without reshuffling: glm-4.7
    // (¥105.66) stays above glm-4.6 (¥50.46).
    fireEvent.change(within(dialog).getByLabelText('搜索模型'), { target: { value: 'glm' } })
    orderOf(['glm-4.7', 'glm-4.6'])
    fireEvent.change(within(dialog).getByLabelText('搜索模型'), { target: { value: '' } })
    // Click 2: cost asc — ¥12.71 first, the equal ¥105.66 pair keeps
    // family order at the end.
    fireEvent.click(head())
    expect(head().textContent).toBe('模拟费用 ▴')
    orderOf(['gemini-3.7-flash', 'deepseek-v4-pro', 'MiniMax-M3', 'glm-4.6', 'kimi-k2', 'deepseek-chat', 'glm-4.7'])
    // Click 3: back to the default family order and its idle glyph.
    fireEvent.click(head())
    expect(head().textContent).toBe('模拟费用 ⇅')
    orderOf(['deepseek-chat', 'deepseek-v4-pro', 'gemini-3.7-flash', 'glm-4.6', 'glm-4.7', 'MiniMax-M3', 'kimi-k2'])
  })

  it('serves the effective-rule price as the main row; a rule-only world has no arrow', async () => {
    const { dialog } = await renderReady()
    // The discount rule owns the present: the main row IS its rates
    // (2M×1 + 457K×2 + 98M×0.1 = ¥12.71), the root's ¥105.66 never shows,
    // and with no slots/tiers on the rule there is no arrow at all.
    const row = within(dialog).getByRole('button', { name: '查看 gemini-3.7-flash 定价' })
    expect(within(row).getByText('12.71￥')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: '展开定价条件' })).toBeNull()
  })

  it('falls back to the root world after expiry and expands its slot row', async () => {
    const { dialog } = await renderReady()
    // Both rules expired → the root world: base prices (2M×4.5 + 457K×13.5
    // + 98M×0.15 = ¥29.87) and the root peak-slot row, shown regardless of
    // the current minute.
    const row = within(dialog).getByRole('button', { name: '查看 deepseek-v4-pro 定价' })
    expect(within(row).getByText('29.87￥')).toBeTruthy()
    const arrow = within(row).getByRole('button', { name: '展开定价条件' })
    fireEvent.click(arrow)
    // The click stays on the arrow: no detail dialog opens.
    expect(screen.queryByRole('dialog', { name: '模型定价' })).toBeNull()
    expect(within(dialog).getByText('高峰时段 09:00-12:00、14:00-18:00')).toBeTruthy()
    expect(within(dialog).getByText('59.74￥')).toBeTruthy()
    // Collapse hides the special row again.
    fireEvent.click(arrow)
    expect(within(dialog).queryByText('59.74￥')).toBeNull()
    // The row itself still opens the detail dialog.
    fireEvent.click(row)
    expect(await screen.findByRole('dialog', { name: '模型定价' })).toBeTruthy()
  })

  it('expands the context tier the scenario input side clears', async () => {
    const { dialog } = await renderReady()
    // Input side = 2M + 98M = 100M ≥ 512K → the tier row; the main row
    // stays at the root base (2M×2.1 + 457K×8.4 + 98M×0.42 = ¥49.20).
    const row = within(dialog).getByRole('button', { name: '查看 MiniMax-M3 定价' })
    expect(within(row).getByText('49.20￥')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: '展开定价条件' }))
    expect(within(dialog).getByText('上下文 ≥512K')).toBeTruthy()
    expect(within(dialog).getByText('98.40￥')).toBeTruthy()
  })

  it('renders the four base-rate columns (USD view converts and notes the rate)', async () => {
    stubFetch(async () => ({ ok: true, json: async () => OVERVIEW }))
    render(<PricingOverviewDialog usedModels={USED} view={{ symbol: '$', rate: 7 }} onClose={() => {}} t={t} />)
    const dialog = await screen.findByRole('dialog', { name: '定价表' })
    const row = await within(dialog).findByRole('button', { name: '查看 deepseek-chat 定价' })
    // ¥2/¥8/¥1/¥4 per million ÷ 7 → $0.2857 / $1.1429 / $0.1429 / $0.5714.
    for (const cell of ['$0.2857', '$1.1429', '$0.1429', '$0.5714']) {
      expect(within(row).getByText(cell)).toBeTruthy()
    }
    // The simulated cost converts too: 105.656￥ ÷ 7 = 15.09$.
    expect(within(row).getByText('15.09$')).toBeTruthy()
    expect(within(dialog).getByText('按 1 USD = 7 CNY 换算')).toBeTruthy()
  })

  it('search filters rows by modelId, alias, or family and keeps the order', async () => {
    const { dialog } = await renderReady()
    const searchBox = () => within(dialog).getByLabelText('搜索模型')
    // An alias hit surfaces its model directly.
    fireEvent.change(searchBox(), { target: { value: 'kimi' } })
    expect(within(dialog).getByText('kimi-k2')).toBeTruthy()
    expect(within(dialog).queryByText('deepseek-chat')).toBeNull()
    expect(within(dialog).queryByText('glm-4.7')).toBeNull()
    // The family name itself matches (case-insensitive).
    fireEvent.change(searchBox(), { target: { value: 'GLM' } })
    expect(within(dialog).getByText('glm-4.6')).toBeTruthy()
    expect(within(dialog).getByText('glm-4.7')).toBeTruthy()
    expect(within(dialog).queryByText('kimi-k2')).toBeNull()
    // Clearing the search restores the full list.
    fireEvent.change(searchBox(), { target: { value: '' } })
    expect(within(dialog).getByText('deepseek-chat')).toBeTruthy()
    expect(within(dialog).getByText('kimi-k2')).toBeTruthy()
  })

  it('shows the failure copy for a rejected fetch and recovers through retry', async () => {
    const fetch = stubFetch(async () => { throw new Error('network down') })
    render(<PricingOverviewDialog usedModels={USED} view={{ symbol: '￥', rate: 1 }} onClose={() => {}} t={t} />)
    expect(await screen.findByText('模型定价获取失败')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()

    fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => OVERVIEW }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('deepseek-chat')).toBeTruthy()
  })

  it('treats an empty mirror as the same failure state', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ...OVERVIEW, models: [] }) }))
    render(<PricingOverviewDialog usedModels={USED} view={{ symbol: '￥', rate: 1 }} onClose={() => {}} t={t} />)
    expect(await screen.findByText('模型定价获取失败')).toBeTruthy()
  })

  it('closes on a true backdrop click but not on a selection drag released outside', async () => {
    const { dialog, onClose } = await renderReady()
    // A selection drag: press inside the input, release outside the
    // dialog — the click fires on the press/release targets' common
    // ancestor, which is the dialog element itself, and must not close it.
    fireEvent.mouseDown(within(dialog).getByLabelText('输入'))
    fireEvent.click(dialog)
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    // A press that started on the backdrop closes like before.
    fireEvent.mouseDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stacks the detail dialog above the overview; a close only unmounts the top one', async () => {
    const { dialog, onClose } = await renderReady()
    // Drill into one model: a second dialog stacks above the overview.
    fireEvent.click(within(dialog).getByRole('button', { name: '查看 deepseek-chat 定价' }))
    const detail = await screen.findByRole('dialog', { name: '模型定价' })
    expect((detail as HTMLDialogElement).open).toBe(true)
    expect((dialog as HTMLDialogElement).open).toBe(true)
    // The detail shares the backdrop guard: a selection drag released
    // outside it does not close it.
    fireEvent.mouseDown(within(detail).getByText('deepseek-chat'))
    fireEvent.click(detail)
    expect((detail as HTMLDialogElement).open).toBe(true)
    // Esc on the top dialog (jsdom stand-in: its close event) unmounts only
    // the detail — the overview stays open, untouched, and its own onClose
    // never fires.
    ;(detail as HTMLDialogElement).close()
    expect(screen.queryByRole('dialog', { name: '模型定价' })).toBeNull()
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    // A second close lands on the overview itself.
    ;(dialog as HTMLDialogElement).close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
