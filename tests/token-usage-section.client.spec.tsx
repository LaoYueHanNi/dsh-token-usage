// @vitest-environment jsdom
/**
 * Token-usage settings page component tests: renders the loading, error, and
 * ready states over a stubbed fetch, exercises the filter bar (day range,
 * model select, quick range buttons), pins the per-model table column order,
 * and pins the token-abbreviation and cache-hit-rate formatting.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatHitRate, formatTokens, TokenUsageSection, totalTokens } from '../src/client/TokenUsageSection.tsx'
import type { UsageSummary } from '../src/wire.ts'

/** A fully populated summary fixture. */
const SUMMARY: UsageSummary = {
  dataDir: 'C:/data/token-usage',
  total: {
    requests: 4,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  },
  byDay: [
    { day: '2026-01-15', totals: { requests: 2, inputTokens: 20, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1 } },
    { day: '2026-01-16', totals: { requests: 2, inputTokens: 10, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 1 } },
  ],
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
  }],
  byDayModel: [
    { day: '2026-01-15', model: 'deepseek-chat', totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { day: '2026-01-16', model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 100, outputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 } },
  ],
  recent: [],
}

function stubFetch(impl: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

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
    render(<TokenUsageSection close={() => {}} />)
    expect(screen.getByText('加载中…')).toBeTruthy()
    // '总 token' appears twice: the card label and the table column header.
    expect(await screen.findAllByText('总 token')).toHaveLength(2)
    // Row 1 cards: requests / total tokens (47) / hit rate (9.1%).
    expect(screen.getAllByText('请求数').length).toBeGreaterThan(0)
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('47')).toBeTruthy()
    expect(screen.getByText('9.1%')).toBeTruthy()
    // Row 2 cards: the four buckets (labels also head the table columns).
    expect(screen.getAllByText('输入').length).toBeGreaterThan(0)
    // '30' matches the card value and possibly a y-axis tick; at least the card is there.
    expect(screen.getAllByText('30').length).toBeGreaterThan(0)
    expect(screen.getAllByText('输出').length).toBeGreaterThan(0)
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getAllByText('缓存读').length).toBeGreaterThan(0)
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getAllByText('缓存写').length).toBeGreaterThan(0)
    expect(screen.getByText('2')).toBeTruthy()
    // Per-model table: one row with the model's own totals (200 total, 28.6% hit rate).
    expect(screen.getByText('按模型')).toBeTruthy()
    const table = screen.getByRole('table')
    expect(within(table).getByText('deepseek-reasoner')).toBeTruthy()
    expect(within(table).getByText('200')).toBeTruthy()
    expect(within(table).getByText('28.6%')).toBeTruthy()
    expect(within(table).getByText('100')).toBeTruthy()
    expect(within(table).getByText('60')).toBeTruthy()
    expect(within(table).getByText('40')).toBeTruthy()
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
    render(<TokenUsageSection close={() => {}} />)
    expect(await screen.findByText(/暂无数据/)).toBeTruthy()
  })

  it('shows the failure and retries the fetch', async () => {
    const fetch = stubFetch(async () => {
      throw new Error('network down')
    })
    render(<TokenUsageSection close={() => {}} />)
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
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    expect(screen.queryByText('刷新')).toBeNull()
  })

  it('renders the filter bar: quick range select, two date inputs, model select', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    const quick = screen.getByLabelText('快捷区间') as HTMLSelectElement
    expect(quick.value).toBe('1')
    for (const label of ['1d', '7d', '30d', '自定义']) {
      expect(within(quick).getByText(label)).toBeTruthy()
    }
    expect(screen.getByLabelText('开始日期')).toBeTruthy()
    expect(screen.getByLabelText('结束日期')).toBeTruthy()
    const select = screen.getByLabelText('模型')
    expect(within(select).getByText('全部模型')).toBeTruthy()
    expect(within(select).getByText('deepseek-reasoner')).toBeTruthy()
  })

  it('defaults to the 1d window: inputs and quick select reflect today', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    const url = new URL(String(fetch.mock.calls[0]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(0))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
    expect(screen.getByLabelText('开始日期').getAttribute('value')).toBe(dayKey(0))
    expect(screen.getByLabelText('结束日期').getAttribute('value')).toBe(dayKey(0))
    expect((screen.getByLabelText('快捷区间') as HTMLSelectElement).value).toBe('1')
  })

  it('fetches the 7d window (today minus 6 through today) when 7d is chosen', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('快捷区间'), { target: { value: '7' } })
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(-6))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
    // Back in the ready state, the select reflects the active window.
    await screen.findAllByText('总 token')
    expect((screen.getByLabelText('快捷区间') as HTMLSelectElement).value).toBe('7')
  })

  it('fetches with the model parameter when a model is chosen', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'deepseek-reasoner' } })
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('model')).toBe('deepseek-reasoner')
  })

  it('marks the quick range custom once the day inputs diverge', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: dayKey(-3) } })
    await screen.findAllByText('总 token')
    expect((screen.getByLabelText('快捷区间') as HTMLSelectElement).value).toBe('custom')
  })

  it('skips fetching while the range is mid-edit (from after to)', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    // Start from the 7d quick window, then move the start past its end.
    fireEvent.change(screen.getByLabelText('快捷区间'), { target: { value: '7' } })
    await waitForCall(fetch, 2)
    await screen.findAllByText('总 token')
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: dayKey(5) } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(2)
    // Settling the end date past the start resumes fetching.
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: dayKey(10) } })
    await waitForCall(fetch, 3)
    const url = new URL(String(fetch.mock.calls[2]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(5))
    expect(url.searchParams.get('to')).toBe(dayKey(10))
  })

  it('orders the per-model columns with the hit rate last', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers.map(cell => cell.textContent)).toEqual(
      ['模型', '请求数', '总 token', '输入', '输出', '缓存读', '缓存写', '命中率'])
  })

  it('renders the daily token chart from the day rows', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    await screen.findAllByText('总 token')
    // The fixture's days are in the past; clear the default 1d window so the
    // chart spans the fixture rows (the real server filters byDay instead).
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '' } })
    await screen.findAllByText('总 token')
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '' } })
    const chart = await screen.findByRole('img', { name: '每日总 token 曲线' })
    // Day totals are 31 and 16, so the y axis tops out at a round 40 (ticks 10..40).
    for (const tick of ['10', '20', '30', '40']) {
      expect(within(chart).getByText(tick)).toBeTruthy()
    }
    // Day labels (MM-DD) close the x axis.
    expect(within(chart).getByText('01-15')).toBeTruthy()
    expect(within(chart).getByText('01-16')).toBeTruthy()
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
