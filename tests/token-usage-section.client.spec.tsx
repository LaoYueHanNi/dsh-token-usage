// @vitest-environment jsdom
/**
 * Token-usage settings page component tests: renders the loading, error, and
 * ready states over a stubbed fetch, exercises the filter bar (the range
 * date picker popover, model select, quick range buttons), pins the per-model
 * table column order,
 * pins the token-abbreviation and cache-hit-rate formatting, and covers the
 * per-model pricing dialog (open/close, full rule-chain rows).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatHitRate, formatTokens, TokenUsageSection, totalTokens } from '../src/client/TokenUsageSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageSummary } from '../src/wire.ts'

/** Common-namespace zh values the tests assert against (shell-owned copy). */
const COMMON_ZH: Record<string, string> = {
  loading: '加载中…',
  retry: '重试',
  'load.failed': '加载失败',
}

/**
 * zh-bound translate stub: renders the same copy the tests were written on,
 * with `{name}` template substitution like the real lookup chain.
 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? COMMON_ZH[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** A fully populated summary fixture (reasoner priced at ¥4/¥16/¥1 per million). */
const SUMMARY: UsageSummary = {
  dataDir: 'C:/data/token-usage',
  currency: 'CNY',
  usdExchangeRate: 7,
  total: {
    requests: 4,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  },
  totalCost: 0.0014,
  unpricedModels: [],
  pricing: {
    'deepseek-reasoner': {
      base: { inputPerMillion: 4, outputPerMillion: 16, cacheReadPerMillion: 1 },
      contextTiers: [],
      dailySlots: [],
      timeRules: [],
    },
  },
  byDay: [
    { day: '2026-01-15', totals: { requests: 2, inputTokens: 20, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1 } },
    { day: '2026-01-16', totals: { requests: 2, inputTokens: 10, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 1 } },
  ],
  byHour: [],
  byModel: [{
    // Values distinct from the totals cards so table assertions are unambiguous.
    model: 'deepseek-reasoner',
    totals: {
      requests: 1,
      inputTokens: 100,
      outputTokens: 60,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    },
    cost: 0.0014,
  }],
  rateRows: [
    { day: '2026-01-15', model: 'deepseek-chat', rate: { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }, totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { day: '2026-01-16', model: 'deepseek-reasoner', rate: { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }, totals: { requests: 1, inputTokens: 100, outputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 } },
  ],
  recent: [],
}

function stubFetch(impl: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

// jsdom ships no dialog methods; stub the pair showModal/close so the
// pricing dialog behaves like a browser (close fires the `close` event
// the component's onClose listens for).
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

describe('formatTokens', () => {
  it('keeps raw counts below 1K', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses K below 1M', () => {
    expect(formatTokens(1_234)).toBe('1.2K')
    expect(formatTokens(12_345)).toBe('12K')
    expect(formatTokens(950_000)).toBe('950K')
    expect(formatTokens(999_999)).toBe('1000K') // boundary: still K tier
  })

  it('uses M from 1M up to 10 亿, never fractional B', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(9_600_000)).toBe('9.6M')
    expect(formatTokens(12_000_000)).toBe('12M')
    expect(formatTokens(100_000_000)).toBe('100M') // 1 亿 stays M
    expect(formatTokens(150_000_000)).toBe('150M')
    expect(formatTokens(950_000_000)).toBe('950M')
    expect(formatTokens(999_999_999)).toBe('1000M') // boundary: still M tier
  })

  it('uses B only from 10 亿 (1e9) up', () => {
    expect(formatTokens(1_000_000_000)).toBe('1B')
    expect(formatTokens(1_500_000_000)).toBe('1.5B')
    expect(formatTokens(3_000_000_000)).toBe('3B')
    expect(formatTokens(10_000_000_000)).toBe('10B')
  })
})

describe('totalTokens / formatHitRate', () => {
  it('sums the four buckets', () => {
    expect(totalTokens({ requests: 1, inputTokens: 30, outputTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 2 }))
      .toBe(47)
  })

  it('renders the cache hit rate with one decimal and a dash for nothing served', () => {
    expect(formatHitRate({ requests: 1, inputTokens: 30, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 }))
      .toBe('9.1%')
    expect(formatHitRate({ requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }))
      .toBe('100%')
    expect(formatHitRate({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
      .toBe('—')
  })
})

describe('TokenUsageSection', () => {
  it('shows loading then the two metric rows and the per-model table', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(screen.getByText('加载中…')).toBeTruthy()
    // '总 token' appears twice: the card label and the table column header.
    expect(await screen.findAllByText('总 token')).toHaveLength(2)
    // Row 1 cards: requests / cost / total tokens (47) / hit rate (9.1%).
    expect(screen.getAllByText('请求数').length).toBeGreaterThan(0)
    expect(screen.getByText('4')).toBeTruthy()
    // The cost card and the per-model cost column share the same ¥ figure.
    expect(screen.getAllByText('¥0.00').length).toBeGreaterThan(0)
    expect(screen.getByText('47')).toBeTruthy()
    expect(screen.getByText('9.1%')).toBeTruthy()
    // Same four-bucket colour as the header chip: 9.1% is `critical`.
    expect(document.querySelector('[class*="band_critical"]')?.textContent).toBe('9.1%')
    // Row 2 cards: the four buckets (labels also head the table columns).
    expect(screen.getAllByText('入').length).toBeGreaterThan(0)
    // '30' matches the card value and possibly a y-axis tick; at least the card is there.
    expect(screen.getAllByText('30').length).toBeGreaterThan(0)
    expect(screen.getAllByText('出').length).toBeGreaterThan(0)
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getAllByText('缓').length).toBeGreaterThan(0)
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getAllByText('写').length).toBeGreaterThan(0)
    expect(screen.getByText('2')).toBeTruthy()
    // Per-model table: one row with the model's own totals (200 total, 28.6% hit rate).
    expect(screen.getByText('按模型')).toBeTruthy()
    const table = screen.getByRole('table', { name: '按模型' })
    expect(within(table).getByText('deepseek-reasoner')).toBeTruthy()
    expect(within(table).getByText('200')).toBeTruthy()
    expect(within(table).getByText('28.6%')).toBeTruthy()
    expect(within(table).getByText('28.6%').className).toMatch(/band_critical/)
    expect(within(table).getByText('100')).toBeTruthy()
    expect(within(table).getByText('60')).toBeTruthy()
    expect(within(table).getByText('40')).toBeTruthy()
    expect(within(table).getByText('¥0.00')).toBeTruthy()
    // The priced model row carries the pricing affordance; no dialog yet.
    expect(within(table).getByRole('button', { name: '查看 deepseek-reasoner 定价' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    // No per-day / recent sections.
    expect(screen.queryByText('按日')).toBeNull()
    expect(screen.queryByText('最近请求')).toBeNull()
  })

  it('shows the empty hint when nothing matches', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byModel: [],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(await screen.findByText(/暂无数据/)).toBeTruthy()
    // No model rows without a selection, so no pricing affordance either.
    expect(screen.queryByRole('button', { name: /定价/ })).toBeNull()
  })

  it('warns about unpriced models and dashes their cost', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        totalCost: 0.0014,
        unpricedModels: ['deepseek-reasoner'],
        pricing: {},
        byModel: [{ ...SUMMARY.byModel[0]!, cost: 0 }],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(await screen.findByText(/1 个模型未定价：deepseek-reasoner/)).toBeTruthy()
    const table = screen.getByRole('table', { name: '按模型' })
    expect(within(table).getByText('未定价')).toBeTruthy()
    // Unpriced cost cells render an em dash, not a fake ¥0.00, and the
    // row carries no pricing affordance.
    expect(within(table).getByText('—')).toBeTruthy()
    expect(within(table).queryByRole('button', { name: /定价/ })).toBeNull()
  })

  it('renders costs and rates in USD under an overseas summary', async () => {
    // large enough to be visible at $ scale: ¥7.00 ÷ 7 = $1.00.
    const usdSummary: UsageSummary = {
      ...SUMMARY,
      currency: 'USD',
      usdExchangeRate: 7,
      totalCost: 7,
      byModel: [{ ...SUMMARY.byModel[0]!, cost: 7 }],
    }
    stubFetch(async () => ({ ok: true, json: async () => usdSummary }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    // The cost card and the per-model cost column both read $1.00.
    expect(await screen.findAllByText('总 token')).toHaveLength(2)
    expect(screen.getAllByText('$1.00').length).toBeGreaterThan(0)

    // The pricing dialog converts every rate: ¥4/¥16 → $0.5714/$2.2857,
    // cache read ¥1 → $0.1429, cache write falls back to input $0.5714.
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const dialog = await screen.findByRole('dialog')
    const table = within(dialog).getByRole('table')
    expect(within(table).getByText('默认').closest('tr')!.textContent).toBe('默认$0.5714$2.2857$0.1429$0.5714')
    // The conversion note names the rate.
    expect(within(dialog).getByText('按 1 USD = 7 CNY 换算')).toBeTruthy()
    // Close the dialog to leave a clean tree.
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('uses the USD symbol in the unpriced warning', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        currency: 'USD',
        usdExchangeRate: 7,
        totalCost: 7,
        unpricedModels: ['deepseek-reasoner'],
        pricing: {},
        byModel: [{ ...SUMMARY.byModel[0]!, cost: 0 }],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    // The unpriced placeholder is a converted zero, not a hard ¥.
    expect(await screen.findByText(/费用按 \$0\.00 计/)).toBeTruthy()
    const table = screen.getByRole('table', { name: '按模型' })
    expect(within(table).getByText('—')).toBeTruthy()
  })

  it('shows the failure and retries the fetch', async () => {
    const fetch = stubFetch(async () => {
      throw new Error('network down')
    })
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(await screen.findByText(/统计加载失败：network down/)).toBeTruthy()

    fetch.mockResolvedValueOnce({ ok: true, json: async () => SUMMARY })
    fireEvent.click(screen.getByText('重试'))
    expect(await screen.findAllByText('总 token')).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('TokenUsageSection filtering', () => {
  /** Local `YYYY-MM-DD` of today shifted by whole days. */
  function dayKey(offsetDays: number): string {
    const date = new Date()
    date.setDate(date.getDate() + offsetDays)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }

  it('renders no refresh button once ready', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    expect(screen.queryByText('刷新')).toBeNull()
  })

  it('mirrors the shell root color-scheme and follows theme switches', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // The shell projects the active scheme onto documentElement.style only;
    // the section mirrors it so its form controls render natively dark.
    // (MutationObserver delivers asynchronously, hence the awaits.)
    document.documentElement.style.colorScheme = 'dark'
    await new Promise(resolve => setTimeout(resolve, 0))
    const root = screen.getByText('Token 用量').closest('div')
    expect(root?.style.colorScheme).toBe('dark')
    // A theme switch rewrites the root inline style; the mirror follows.
    document.documentElement.style.colorScheme = 'light'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root?.style.colorScheme).toBe('light')
    document.documentElement.style.removeProperty('color-scheme')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root?.style.colorScheme).toBe('')
  })

  it('renders the filter bar: quick range menu, date range trigger, model menu', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const quick = screen.getByRole('button', { name: '快捷区间' })
    expect(quick.textContent).toBe('1d')
    fireEvent.click(quick)
    for (const label of ['1d', '7d', '30d', '全部日期', '自定义']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: '日期范围' })).toBeTruthy()
    const model = screen.getByRole('button', { name: '模型' })
    expect(model.textContent).toBe('全部模型')
    fireEvent.click(model)
    expect(screen.getByRole('option', { name: '全部模型' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'deepseek-reasoner' })).toBeTruthy()
  })

  it('defaults to the 1d window: triggers reflect today', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const url = new URL(String(fetch.mock.calls[0]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(0))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
    expect(screen.getByRole('button', { name: '日期范围' }).textContent).toBe(`${dayKey(0)} 至 ${dayKey(0)}`)
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('1d')
  })

  it('fetches the 7d window (today minus 6 through today) when 7d is chosen', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '7d' }))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(-6))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
    // Back in the ready state, the trigger reflects the active window.
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('7d')
  })

  it('fetches unconstrained when ALL is chosen from the quick menu', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '全部日期' }))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBeNull()
    expect(url.searchParams.get('to')).toBeNull()
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('全部日期')
  })

  it('fetches with the model parameter when a model is chosen', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-reasoner' }))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('model')).toBe('deepseek-reasoner')
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('deepseek-reasoner')
  })

  it('marks the quick range custom once the popover settles a non-quick range', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText('上个月'))
    // The previous month's first day clicked twice: a single-day custom range
    // that never equals a quick range (those end on today).
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('自定义')
  })

  it('sorts the range when the second click lands earlier than the first', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // Click today first (the LATER end), then the previous month's first day:
    // the committed range still arrives sorted.
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(dayKey(0)))
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(prevMonthFirstDay())
    expect(url.searchParams.get('to')).toBe(dayKey(0))
  })

  it('orders the per-model columns with the cost and hit rate last-but-one / last', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const headers = within(screen.getByRole('table', { name: '按模型' })).getAllByRole('columnheader')
    expect(headers.map(cell => cell.textContent)).toEqual(
      ['模型', '请求数', '费用', '总 token', '入', '出', '缓', '写', '命中率'])
  })

  it('opens a pricing dialog from the model row: each billing condition on its own row', async () => {
    // 2026-01-01 / 2026-02-01 at 12:00 UTC: the same local date in every
    // realistic timezone, so the window text is stable on any runner.
    const RULE_START = 1_767_268_800
    const RULE_END = 1_769_947_200
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        pricing: {
          'glm-5.2': {
            base: { inputPerMillion: 2, outputPerMillion: 8 },
            contextTiers: [{ threshold: 512000, rates: { inputPerMillion: 6, outputPerMillion: 24 }, dailySlots: [{ windows: [{ startMinute: 600, endMinute: 660 }], daysOfWeek: [6, 7], rates: { inputPerMillion: 6.5, outputPerMillion: 26 } }] }],
            dailySlots: [{
              label: '峰时',
              windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
              daysOfWeek: [1, 2, 3, 4, 5],
              rates: { inputPerMillion: 4, outputPerMillion: 16 },
            }],
            timeRules: [{
              label: '原价',
              startTime: RULE_START,
              endTime: RULE_END,
              rates: { inputPerMillion: 1, outputPerMillion: 2 },
              contextTiers: [{ threshold: 128000, rates: { inputPerMillion: 3, outputPerMillion: 6 } }],
              dailySlots: [{
                label: '峰时',
                windows: [{ startMinute: 600, endMinute: 660 }],
                daysOfWeek: [1, 3],
                rates: { inputPerMillion: 1.5, outputPerMillion: 3 },
              }],
            }],
          },
          'deepseek-reasoner': SUMMARY.pricing['deepseek-reasoner']!,
          // Priced, but absent from the filter selection: no affordance.
          'unused-model': SUMMARY.pricing['deepseek-reasoner']!,
        },
        byModel: [
          { model: 'glm-5.2', totals: { requests: 5, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0.5 },
          ...SUMMARY.byModel,
        ],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')

    // The unused priced model never surfaces an affordance.
    expect(screen.queryByRole('button', { name: /unused-model/ })).toBeNull()

    // Open the rule-carrier's dialog from its row.
    fireEvent.click(screen.getByRole('button', { name: '查看 glm-5.2 定价' }))
    const dialog = await screen.findByRole('dialog')
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(within(dialog).getByText('glm-5.2')).toBeTruthy()
    const glmTable = within(dialog).getByRole('table')

    // The rule-carrier: condition column first, four rate columns after.
    expect(within(glmTable).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['计费条件', '入/M', '出/M', '缓/M', '写/M'])
    // The regular group (outside the rule window) opens the table…
    expect(within(glmTable).getByText('常规（规则期外）')).toBeTruthy()
    // …default rates (cache falls back to the input rate), then the context
    // tier, then the root peak slot with both of its windows. Slots carrying
    // `daysOfWeek` render by label + windows only — the weekday restriction
    // stays out of the condition text.
    expect(within(glmTable).getAllByText('默认')[0]!.closest('tr')!.textContent).toBe('默认¥2¥8¥2¥2')
    expect(within(glmTable).getByText('上下文 ≥512K').closest('tr')!.textContent).toBe('上下文 ≥512K¥6¥24¥6¥6')
    expect(within(glmTable).getByText('峰时 09:00-12:00、14:00-18:00').closest('tr')!.textContent)
      .toBe('峰时 09:00-12:00、14:00-18:00¥4¥16¥4¥4')
    // …then the time rule gets its own group with its date window, an
    // isolated default, its own tier, and its own peak slot.
    expect(within(glmTable).getByText('原价 2026-01-01 ~ 2026-02-01')).toBeTruthy()
    expect(within(glmTable).getAllByText('默认')).toHaveLength(2)
    expect(within(glmTable).getAllByText('默认')[1]!.closest('tr')!.textContent).toBe('默认¥1¥2¥1¥1')
    expect(within(glmTable).getByText('上下文 ≥128K').closest('tr')!.textContent).toBe('上下文 ≥128K¥3¥6¥3¥3')
    expect(within(glmTable).getByText('上下文 ≥512K · 峰时 10:00-11:00').closest('tr')!.textContent)
      .toBe('上下文 ≥512K · 峰时 10:00-11:00¥6.50¥26¥6.50¥6.50')
    expect(within(glmTable).getByText('峰时 10:00-11:00').closest('tr')!.textContent).toBe('峰时 10:00-11:00¥1.50¥3¥1.50¥1.50')

    // The close button dismisses the dialog.
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // The flat model: one default row, explicit cache read rate, cache
    // write falling back to the input rate, no group divider.
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const flatDialog = await screen.findByRole('dialog')
    const flatTable = within(flatDialog).getByRole('table')
    expect(within(flatTable).queryByText('常规（规则期外）')).toBeNull()
    expect(within(flatTable).getByText('默认').closest('tr')!.textContent).toBe('默认¥4¥16¥1¥4')
  })

  it('drops the bogus 1970 start of a since-forever time rule', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        pricing: {
          'deepseek-reasoner': {
            base: { inputPerMillion: 2, outputPerMillion: 8 },
            contextTiers: [],
            dailySlots: [],
            timeRules: [{ label: '原价', startTime: 0, endTime: 1_786_881_600, rates: { inputPerMillion: 1, outputPerMillion: 2 } }],
          },
        },
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const dialog = await screen.findByRole('dialog')
    // “~ <end>”, not “1970-01-01 ~ <end>”.
    expect(within(dialog).getByText('原价 ~ 2026-08-16')).toBeTruthy()
  })

  it('orders the rule groups newest era first, regardless of feed order', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        pricing: {
          'deepseek-reasoner': {
            base: { inputPerMillion: 2, outputPerMillion: 8 },
            contextTiers: [],
            dailySlots: [],
            // 12:00 UTC bounds: the same local date on every runner. The feed
            // lists the oldest era first, as the real feed does.
            timeRules: [
              { label: '原价', startTime: 0, endTime: Date.UTC(2026, 3, 25, 12) / 1000, rates: { inputPerMillion: 4, outputPerMillion: 16 } },
              { label: '长期降价', startTime: Date.UTC(2026, 3, 25, 12) / 1000, endTime: Date.UTC(2026, 7, 16, 12) / 1000, rates: { inputPerMillion: 2, outputPerMillion: 8 } },
            ],
          },
        },
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const dialog = await screen.findByRole('dialog')
    const table = within(dialog).getByRole('table')
    // Group headers top-to-bottom: the model root (current era) first, then
    // the rule eras newest first (larger end higher).
    const groups = [...table.querySelectorAll('td[colspan="5"]')].map(cell => cell.textContent)
    expect(groups).toEqual(['常规（规则期外）', '长期降价 2026-04-25 ~ 2026-08-16', '原价 ~ 2026-04-25'])
  })

  it('renders the daily token chart from the day rows', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // The fixture's days are in the past; clear the default 1d window so the
    // chart spans the fixture rows (the real server filters byDay instead).
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByText('清除范围'))
    await screen.findAllByText('总 token')
    const chart = await screen.findByRole('img', { name: '每日总 token 曲线' })
    // Day totals are 31 and 16, so the y axis tops out at a round 40 (ticks 10..40).
    for (const tick of ['10', '20', '30', '40']) {
      expect(within(chart).getByText(tick)).toBeTruthy()
    }
    // Day labels (MM-DD) close the x axis.
    expect(within(chart).getByText('01-15')).toBeTruthy()
    expect(within(chart).getByText('01-16')).toBeTruthy()
  })

  it('floats a day label when a chart point is hovered or focused', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByText('清除范围'))
    await screen.findAllByText('总 token')
    const chart = await screen.findByRole('img', { name: '每日总 token 曲线' })

    // No label before any interaction.
    expect(within(chart).queryByText(/总量/)).toBeNull()

    // Hovering a day's hit zone floats its date + total (day 2 totals 16).
    fireEvent.mouseEnter(within(chart).getByLabelText('2026-01-16 总量 16'))
    expect(within(chart).getByText('2026-01-16 总量 16')).toBeTruthy()
    // Hovering the other day swaps the label (day 1 totals 31).
    fireEvent.mouseEnter(within(chart).getByLabelText('2026-01-15 总量 31'))
    expect(within(chart).getByText('2026-01-15 总量 31')).toBeTruthy()

    // Keyboard focus works the same way; leaving the chart clears the label.
    fireEvent.focus(within(chart).getByLabelText('2026-01-16 总量 16'))
    expect(within(chart).getByText('2026-01-16 总量 16')).toBeTruthy()
    fireEvent.mouseLeave(chart)
    expect(within(chart).queryByText(/总量/)).toBeNull()
  })

  it('renders the 1d window as the day\'s 24-hour trend, folding models per hour', async () => {
    // Hourly rows on today (the default 1d window): 1K at 09:00, 3K at 14:00.
    const today = dayKey(0)
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        byHour: [
          { hour: `${today}T09`, model: 'deepseek-chat', totals: { requests: 1, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          { hour: `${today}T09`, model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          { hour: `${today}T14`, model: 'deepseek-chat', totals: { requests: 1, inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        ],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const chart = await screen.findByRole('img', { name: '单日分时 token 曲线' })
    // The full 00:00-23:00 sequence: 24 plotted hours, future ones at zero.
    expect(within(chart).getAllByLabelText(/总量/)).toHaveLength(24)
    // Hourly totals 1K and 3K, so the y axis tops out at a round 3K.
    for (const tick of ['1K', '2K', '3K']) {
      expect(within(chart).getByText(tick)).toBeTruthy()
    }
    // Clock labels (HH:00) close the x axis at first/middle/last.
    expect(within(chart).getByText('00:00')).toBeTruthy()
    expect(within(chart).getByText('11:00')).toBeTruthy()
    expect(within(chart).getByText('23:00')).toBeTruthy()
    // Hovering an hour floats its date + clock time; both models fold into 09:00.
    fireEvent.mouseEnter(within(chart).getByLabelText(`${today} 09:00 总量 1K`))
    expect(within(chart).getByText(`${today} 09:00 总量 1K`)).toBeTruthy()
  })

  it('switches back to the daily chart once the range spans more than one day', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // The default 1d window renders the hourly chart.
    expect(await screen.findByRole('img', { name: '单日分时 token 曲线' })).toBeTruthy()
    // A wider range falls back to the daily granularity.
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '7d' }))
    await waitForCall(fetch, 2)
    expect(await screen.findByRole('img', { name: '每日总 token 曲线' })).toBeTruthy()
  })
})

/** Local `YYYY-MM-DD` of today. */
function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Local `YYYY-MM-DD` of the first day of the month before the current one. */
function prevMonthFirstDay(): string {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const month = String(first.getMonth() + 1).padStart(2, '0')
  return `${first.getFullYear()}-${month}-01`
}

describe('DateRangePicker', () => {
  it('keeps the first click while navigating months, then settles a cross-month range', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // An anchor on a mid-month day of the CURRENT month (distinct from the
    // committed 1d endpoints, so its highlight can only come from the anchor).
    const now = new Date()
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const anchorDay = todayKey() === `${monthPrefix}-01` ? `${monthPrefix}-02` : `${monthPrefix}-01`
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(anchorDay))
    // Month navigation keeps the selection progress: navigate away and back,
    // the first click stays highlighted (aria-pressed on the day button).
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText('下个月'))
    expect(screen.getByLabelText(anchorDay).getAttribute('aria-pressed')).toBe('true')
    // The second click lands on the previous month: a cross-month range.
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(prevMonthFirstDay())
    expect(url.searchParams.get('to')).toBe(anchorDay)
  })

  it('discards the pending anchor when Escape closes the popover', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(todayKey()))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '日期范围' })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
    // Reopening starts fresh: the next first click is only an anchor (the
    // panel stays open), so the second click settles a clean range.
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    expect(screen.getByRole('dialog', { name: '日期范围' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('下个月'))
    fireEvent.click(screen.getByLabelText(todayKey()))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(prevMonthFirstDay())
    expect(url.searchParams.get('to')).toBe(todayKey())
  })

  it('closes on an outside pointerdown and keeps the committed range', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(todayKey()))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: '日期范围' })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '日期范围' }).textContent).toBe(`${todayKey()} 至 ${todayKey()}`)
  })

  it('clears the range back to unconstrained', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByText('清除范围'))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBeNull()
    expect(url.searchParams.get('to')).toBeNull()
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '日期范围' }).textContent).toBe('全部日期')
    // The unconstrained range reflects as the quick menu's ALL entry.
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('全部日期')
  })
})

describe('MenuSelect', () => {
  /** Local `YYYY-MM-DD` of today shifted by whole days. */
  function dayKey(offsetDays: number): string {
    const date = new Date()
    date.setDate(date.getDate() + offsetDays)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }

  it('marks the selected option while the menu is open', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    expect(screen.getByRole('option', { name: '全部模型' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: 'deepseek-reasoner' }).getAttribute('aria-selected')).toBe('false')
  })

  it('closes the menu without changing the value on Escape', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('1d')
    // Escape returns focus to the trigger.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '快捷区间' }))
  })

  it('roams the list with the keyboard and commits with Enter', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const trigger = screen.getByRole('button', { name: '快捷区间' })
    trigger.focus()
    // The trigger's arrow key opens the menu, focus landing on the
    // selected option (1d).
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    // The selected row's text carries its check mark, hence toContain.
    expect((document.activeElement as HTMLElement).textContent).toContain('1d')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect((document.activeElement as HTMLElement).textContent).toContain('7d')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect((document.activeElement as HTMLElement).textContent).toContain('自定义')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect((document.activeElement as HTMLElement).textContent).toContain('1d')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    // Committing closes the menu. (Focus refocusing on the trigger happens
    // inside the handler, but the commit's refetch swaps the section into
    // its loading branch — unmounting the whole filter bar, focus with it —
    // so no focus assertion survives here; the Escape case covers it.)
    expect(screen.queryByRole('listbox')).toBeNull()
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(-6))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
  })

  it('opens with focus on the selected option, scrolled into view', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // Pick a non-first model first, so the re-open must find it mid-list.
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-reasoner' }))
    await screen.findAllByText('总 token')
    // jsdom ships no scrollIntoView; record the elements it is asked to show.
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element): void { scrolled.push(this) }
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute('aria-selected')).toBe('true')
    expect(focused.textContent).toContain('deepseek-reasoner')
    expect(scrolled).toContain(focused)
  })
})

/** Resolve once the stubbed fetch has been called `count` times. */
async function waitForCall(fetch: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (fetch.mock.calls.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(count)
}
