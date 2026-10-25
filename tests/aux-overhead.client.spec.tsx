// @vitest-environment jsdom
/**
 * Runtime-overhead card rows: the settings page's read-only breakdown of the
 * auxiliary (bypass) model requests, in the dashboards' row shape. Pins the
 * visible contract — kind rows are collapsed by default and their per-model
 * detail lines appear only through the kind's disclosure toggle, each row
 * reads calls · cost · tokens, an unavailable pricing table dashes every
 * cost, and a summary without auxiliary data (including an older host
 * payload with no `aux` field at all) shows the empty hint.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { OverheadRows } from '../src/client/OverheadRows.tsx'
import { formatCost, formatTokens } from '../src/client/format.ts'
import type { CurrencyView } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import type { AuxSummary, UsageTotals } from '../src/wire.ts'

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

describe('OverheadRows', () => {
  afterEach(() => { cleanup() })

  it('expands each kind by default and folds its per-model lines through the toggle', () => {
    render(<OverheadRows aux={AUX} costState="ready" view={VIEW} t={t} />)
    const list = screen.getByRole('list', { name: zh['aux.tab'] })
    // Expanded by default (the user's pick): every kind's per-model line
    // shows beneath its aggregate row.
    const kinds = within(list).getAllByRole('listitem')
    expect(kinds).toHaveLength(2)
    expect(within(list).getByText('deepseek-flash')).toBeTruthy()
    expect(within(list).getByText('glm-4.7')).toBeTruthy()
    // The kind row carries the aggregate: calls · cost · tokens (the row's
    // text nodes interleave the separators, so assert on the joined text).
    const autoReview = kinds[0]!
    expect(autoReview.textContent).toContain(zh['aux.requestCount'].replace('{count}', '2'))
    expect(autoReview.textContent).toContain(formatCost(0.1, VIEW))
    expect(autoReview.textContent).toContain(formatTokens(110))
    // Activating the disclosure folds its per-model line away;
    // `aria-expanded` tracks the state.
    const toggle = within(autoReview).getByRole('button', { name: zh['aux.kind.auto-review'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(list).queryByText('deepseek-flash')).toBeNull()
    expect(within(list).getByText('glm-4.7')).toBeTruthy()
    // A second activation re-expands the model line.
    fireEvent.click(within(list).getByRole('button', { name: zh['aux.kind.auto-review'] }))
    expect(within(list).getByText('deepseek-flash')).toBeTruthy()
  })

  it('folds every kind independently through its own toggle', () => {
    render(<OverheadRows aux={AUX} costState="ready" view={VIEW} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['aux.kind.auto-review'] }))
    const list = screen.getByRole('list', { name: zh['aux.tab'] })
    expect(within(list).queryByText('deepseek-flash')).toBeNull()
    expect(within(list).getByText('glm-4.7')).toBeTruthy()
    // The total line sits beneath the list: calls, then cost · tokens.
    expect(screen.getByText(zh['aux.totalCount'].replace('{count}', '3'))).toBeTruthy()
    const asumText = screen.getByText(zh['aux.totalCount'].replace('{count}', '3')).parentElement!.textContent
    expect(asumText).toContain(formatCost(0.123, VIEW))
    expect(asumText).toContain(formatTokens(165))
  })

  it('renders the empty hint when there is no auxiliary data or the host predates the field', () => {
    const empty = render(<OverheadRows aux={{ ...AUX, total: totals(0, 0, 0), byKind: [] }} costState="ready" view={VIEW} t={t} />)
    expect(screen.getByText(zh['aux.empty'])).toBeTruthy()
    expect(screen.queryByRole('list', { name: zh['aux.tab'] })).toBeNull()
    empty.unmount()
    render(<OverheadRows aux={undefined} costState="ready" view={VIEW} t={t} />)
    expect(screen.getByText(zh['aux.empty'])).toBeTruthy()
  })

  it('dashes every cost when pricing is unavailable', () => {
    render(<OverheadRows aux={AUX} costState="pricing-unavailable" view={VIEW} t={t} />)
    // Both kind rows and the total line read a dash for their cost.
    expect(screen.getAllByText('—')).toHaveLength(3)
    // Expanding every kind dashes the per-model costs too, and no priced
    // figure survives anywhere.
    fireEvent.click(screen.getByRole('button', { name: zh['aux.kind.auto-review'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['aux.kind.translation'] }))
    const list = screen.getByRole('list', { name: zh['aux.tab'] })
    for (const kind of within(list).getAllByRole('listitem')) {
      expect(kind.textContent).toContain('—')
    }
    expect(screen.queryByText(formatCost(0.1, VIEW))).toBeNull()
  })
})
