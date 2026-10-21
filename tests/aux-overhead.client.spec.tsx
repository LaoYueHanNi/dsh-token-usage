// @vitest-environment jsdom
/**
 * Runtime-overhead tab content: the settings page's read-only breakdown of the
 * auxiliary (bypass) model requests, rendered inside the detail dimension
 * switch. Pins the visible contract — kind rows are collapsed by default and
 * their per-model detail lines appear only through the kind's disclosure
 * toggle, the rows carry the same columns, an unavailable pricing table
 * renders the cost cells as a dash, and a summary without auxiliary data
 * (including an older host payload with no `aux` field at all) shows the
 * tab's empty hint.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AuxOverheadSection } from '../src/client/TokenUsageSection.tsx'
import { formatCost, formatTokens } from '../src/client/format.ts'
import type { CurrencyView } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import type { AuxSummary, UsageTotals } from '../src/wire.ts'

// TokenUsageSection imports the shell primitives (CSS-backed); the content
// under test never renders them, so a bare stand-in keeps the module loadable.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Toast: ({ text }: { text: string }) => <div role="alert">{text}</div>,
  IconWarningOutlineRegular: () => <span data-testid="icon-warning" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const VIEW: CurrencyView = { symbol: '￥', rate: 1 }

/** Locale lookup over the real zh dictionary (the key set source of truth). */
const t = ((key: keyof typeof zh) => zh[key]) as unknown as TranslateNS<'token-usage'>

function totals(requests: number, inputTokens: number, outputTokens: number): UsageTotals {
  return { requests, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

const AUX: AuxSummary = {
  total: totals(3, 150, 15),
  cost: 0.123,
  byKind: [
    {
      auxKind: 'auto-review',
      totals: totals(2, 100, 10),
      cost: 0.1,
      byModel: [
        { model: 'deepseek-flash', totals: totals(2, 100, 10), cost: 0.1 },
      ],
    },
    {
      auxKind: 'translation',
      totals: totals(1, 50, 5),
      cost: 0.023,
      byModel: [
        { model: 'glm-4.7', totals: totals(1, 50, 5), cost: 0.023 },
      ],
    },
  ],
}

describe('AuxOverheadSection', () => {
  afterEach(() => { cleanup() })

  it('collapses each kind by default and reveals its per-model lines through the toggle', () => {
    render(<AuxOverheadSection aux={AUX} costState="ready" view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: zh['aux.tab'] })
    // Collapsed by default: header + two kind rows + the total row; no
    // per-model line is visible yet.
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(4)
    expect(within(table).queryByText('deepseek-flash')).toBeNull()
    expect(within(table).queryByText('glm-4.7')).toBeNull()
    // The kind row carries the aggregate figures: 2 calls, priced cost,
    // 110 total tokens.
    const autoReview = rows.find(row => row.textContent?.includes('自动审查'))!
    expect(within(autoReview).getByText('2')).toBeTruthy()
    expect(within(autoReview).getByText(formatCost(0.1, VIEW))).toBeTruthy()
    expect(within(autoReview).getByText(formatTokens(110))).toBeTruthy()
    // Total row: 3 calls and the summed cost.
    const totalRow = rows.find(row => row.textContent?.includes(zh['aux.total']))!
    expect(within(totalRow).getByText('3')).toBeTruthy()
    expect(within(totalRow).getByText(formatCost(0.123, VIEW))).toBeTruthy()
    // Activating the kind's disclosure reveals its per-model line with the
    // same figures; `aria-expanded` tracks the state.
    const toggle = within(table).getByRole('button', { name: '自动审查' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const modelRow = within(table).getAllByRole('row').find(row => row.textContent?.includes('deepseek-flash'))!
    expect(within(modelRow).getByText('2')).toBeTruthy()
    expect(within(modelRow).getByText(formatCost(0.1, VIEW))).toBeTruthy()
    // The other kind stays collapsed until its own toggle fires.
    expect(within(table).queryByText('glm-4.7')).toBeNull()
    // A second activation collapses the model line again.
    fireEvent.click(within(table).getByRole('button', { name: '自动审查' }))
    expect(within(table).queryByText('deepseek-flash')).toBeNull()
  })

  it('expands every kind independently, each model line sharing the kind row columns', () => {
    render(<AuxOverheadSection aux={AUX} costState="ready" view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: zh['aux.tab'] })
    fireEvent.click(within(table).getByRole('button', { name: '自动审查' }))
    fireEvent.click(within(table).getByRole('button', { name: '推理翻译' }))
    // Header + two kind rows + their two per-model lines + the total row.
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(6)
    expect(within(table).getByText('deepseek-flash')).toBeTruthy()
    expect(within(table).getByText('glm-4.7')).toBeTruthy()
    expect(within(table).getByText(zh['aux.total'])).toBeTruthy()
  })

  it('renders the empty hint when there is no auxiliary data or the host predates the field', () => {
    const empty = render(<AuxOverheadSection aux={{ ...AUX, total: totals(0, 0, 0), byKind: [] }} costState="ready" view={VIEW} t={t} />)
    expect(screen.getByText(zh['aux.empty'])).toBeTruthy()
    expect(screen.queryByRole('table', { name: zh['aux.tab'] })).toBeNull()
    empty.unmount()
    render(<AuxOverheadSection aux={undefined} costState="ready" view={VIEW} t={t} />)
    expect(screen.getByText(zh['aux.empty'])).toBeTruthy()
  })

  it('renders a dash for every cost cell when pricing is unavailable', () => {
    render(<AuxOverheadSection aux={AUX} costState="pricing-unavailable" view={VIEW} t={t} />)
    // Collapsed: the two kind rows and the total row.
    expect(screen.getAllByText('—')).toHaveLength(3)
    // Expanding every kind adds its per-model dash cells too.
    fireEvent.click(screen.getByRole('button', { name: '自动审查' }))
    fireEvent.click(screen.getByRole('button', { name: '推理翻译' }))
    expect(screen.getAllByText('—')).toHaveLength(5)
    expect(screen.queryByText(formatCost(0.1, VIEW))).toBeNull()
  })
})
