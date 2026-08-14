// @vitest-environment jsdom
/**
 * Token-usage settings page component tests: renders the loading, error, and
 * ready states over a stubbed fetch, and exercises the retry button.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenUsageSection } from '../src/client/TokenUsageSection.tsx'
import type { UsageSummary } from '../src/wire.ts'

/** A fully populated summary fixture. */
const SUMMARY: UsageSummary = {
  dataDir: 'C:/data/token-usage',
  total: {
    requests: 2,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  },
  byDay: [{
    day: '2026-01-15',
    totals: {
      requests: 2,
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    },
  }],
  byModel: [{
    model: 'deepseek-chat',
    totals: {
      requests: 2,
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    },
  }],
  recent: [{
    requestId: 'm1',
    time: 1_700_000_000_000,
    sessionId: 's1',
    model: 'deepseek-chat',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
  }],
}

function stubFetch(impl: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TokenUsageSection', () => {
  it('shows loading then renders totals, tables, and recent rows', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} />)
    expect(screen.getByText('加载中…')).toBeTruthy()
    expect(await screen.findByText('按日')).toBeTruthy()
    expect(screen.getByText('请求数')).toBeTruthy()
    expect(screen.getAllByText('30').length).toBeGreaterThan(0)
    expect(screen.getByText('2026-01-15')).toBeTruthy()
    expect(screen.getAllByText('deepseek-chat').length).toBeGreaterThan(0)
    expect(screen.getByText(/输入 10 · 输出 5 · 缓存读 3/)).toBeTruthy()
  })

  it('shows the empty hint when nothing was recorded', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byDay: [],
        byModel: [],
        recent: [],
      }),
    }))
    render(<TokenUsageSection close={() => {}} />)
    expect(await screen.findByText(/暂无记录/)).toBeTruthy()
  })

  it('shows the failure and retries the fetch', async () => {
    const fetch = stubFetch(async () => {
      throw new Error('network down')
    })
    render(<TokenUsageSection close={() => {}} />)
    expect(await screen.findByText(/统计加载失败：network down/)).toBeTruthy()

    fetch.mockResolvedValueOnce({ ok: true, json: async () => SUMMARY })
    fireEvent.click(screen.getByText('重试'))
    expect(await screen.findByText('按日')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
