// @vitest-environment jsdom
/**
 * The shared overview board: pins the metric row (the composite lead card
 * 「请求数」with its overhead pill — present only when the
 * aux layer has calls, click wired to the section's activate seat), the
 * plain metric cards, and the trend card's fixed granularity: a
 * single-day window plots the day's 24 hours, a wider one the daily rows —
 * no plot pick in either.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { OverviewBoard } from '../src/client/OverviewBoard.tsx'
import { formatCost } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import type { CurrencyView } from '../src/client/format.ts'
import type { AuxSummary, UsageDayRow, UsageHourRow, UsageTotals } from '../src/wire.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// The chart itself is SVG work irrelevant here — record whether the board
// handed it the hourly points.
vi.mock('../src/client/TrendChart.tsx', () => ({
  TrendChart: (props: { hours?: readonly unknown[] }) => (
    <div data-testid="trend" data-mode={props.hours === undefined ? 'daily' : 'hourly'} />
  ),
}))

const VIEW: CurrencyView = { symbol: '￥', rate: 1 }

/** Locale lookup over the real zh dictionary (the key set source of truth),
 * with the `{name}` interpolation the real shell t applies. */
const t = ((key: keyof typeof zh, vars?: Record<string, string>) => {
  let text: string = zh[key]
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, value)
  }
  return text
}) as unknown as TranslateNS<'token-usage'>

const TOTALS: UsageTotals = {
  requests: 1086,
  inputTokens: 900_000,
  outputTokens: 300_000,
  cacheReadTokens: 40_000_000,
  cacheWriteTokens: 0,
  failures: 6,
  failuresByCode: { RATE_LIMIT: 4, TIMEOUT: 2 },
}

const AUX: AuxSummary = {
  total: { requests: 52, inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 700_000, cacheWriteTokens: 0 },
  cost: 1.34,
  byKind: [
    { auxKind: 'auto-review', totals: { requests: 28, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0.72, byModel: [] },
  ],
}

const BY_DAY = [] as unknown as UsageDayRow[]
const BY_HOUR = [] as unknown as UsageHourRow[]

function board(overrides: Partial<Parameters<typeof OverviewBoard>[0]> = {}): React.ReactElement {
  return (
    <OverviewBoard
      total={TOTALS}
      totalCost={107.7}
      costState="ready"
      aux={AUX}
      byDay={BY_DAY}
      byHour={BY_HOUR}
      from="2026-10-24"
      to="2026-10-24"
      onOverheadActivate={overrides.onOverheadActivate ?? vi.fn()}
      view={VIEW}
      t={t}
      {...overrides}
    />
  )
}

describe('OverviewBoard', () => {
  afterEach(() => { cleanup() })

  it('renders the composite lead card with the overhead pill wired to the activate seat', () => {
    const onOverheadActivate = vi.fn()
    render(board({ onOverheadActivate }))
    // The lead label is the plain 请求数 (the overhead pill carries the
    // aux figure; no 「· 运行开销」 suffix); the hero figure is the count.
    expect(screen.getByText(zh['stat.requests'])).toBeTruthy()
    expect(screen.getByText('1,086')).toBeTruthy()
    // The failure pill and the overhead pill ride beside the hero figure.
    expect(screen.getByText(zh['stat.failuresPill'].replace('{count}', '6'))).toBeTruthy()
    const pill = screen.getByRole('button', { name: zh['stat.overheadPill'].replace('{count}', '52') })
    fireEvent.click(pill)
    expect(onOverheadActivate).toHaveBeenCalledTimes(1)
    // The remaining metric cards are all present.
    for (const key of ['stat.cost', 'stat.totalTokens', 'stat.hitRate', 'stat.input', 'stat.output', 'stat.cacheRead', 'stat.cacheWrite'] as const) {
      expect(screen.getByText(zh[key])).toBeTruthy()
    }
    expect(screen.getByText(formatCost(107.7, VIEW))).toBeTruthy()
  })

  it('falls back to the old two-rows-of-four layout when compact', () => {
    const { container } = render(board({ compact: true }))
    // The panel's narrow body: the lead card reads 请求数 (its pills
    // carry the failure and overhead counts), the grid wraps 4-across.
    expect(screen.getByText(zh['stat.requests'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['stat.overheadPill'].replace('{count}', '52') })).toBeTruthy()
    expect(container.querySelectorAll('[class*="cardSm"]')).toHaveLength(8)
    expect(container.querySelector('[class*="cardLg"]')).toBeNull()
    for (const key of ['stat.cost', 'stat.totalTokens', 'stat.hitRate', 'stat.input', 'stat.output', 'stat.cacheRead', 'stat.cacheWrite'] as const) {
      expect(screen.getByText(zh[key])).toBeTruthy()
    }
  })

  it('renders no overhead pill when the aux layer is absent or empty', () => {
    const empty = render(board({ aux: { ...AUX, total: { ...AUX.total, requests: 0 } } }))
    expect(screen.queryByRole('button', { name: zh['stat.overheadPill'].replace('{count}', '52') })).toBeNull()
    empty.unmount()
    render(board({ aux: undefined }))
    expect(screen.queryByRole('button', { name: zh['stat.overheadPill'].replace('{count}', '52') })).toBeNull()
  })

  it('plots the day hours on a single-day window, no plot pick', () => {
    render(board())
    // A single day plots its 24 hours, fixed — the hourly/daily segmented
    // is gone (it existed only as a single-day fallback that read as
    // clutter next to the two-figure cards).
    expect(screen.getByTestId('trend').getAttribute('data-mode')).toBe('hourly')
    expect(screen.queryByRole('button', { name: '按小时' })).toBeNull()
  })

  it('renders no toggle on a wider window and always plots the daily rows', () => {
    render(board({ from: '2026-10-18', to: '2026-10-24' }))
    expect(screen.queryByRole('button', { name: '按小时' })).toBeNull()
    expect(screen.getByTestId('trend').getAttribute('data-mode')).toBe('daily')
  })
})
