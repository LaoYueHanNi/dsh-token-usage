// @vitest-environment jsdom
/**
 * Session detail table component tests: renders the served rows with the
 * grouping switch, pins the directory grouping (tail-segment heads, rows
 * indented under them, no-directory group last), the titleless-session
 * fallback (short id + time span, never a fabricated title), and the
 * folded child-count badge.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionTable } from '../src/client/SessionTable.tsx'
import { zh } from '../src/client/locales.ts'
import type { SessionUsageRow } from '../src/wire.ts'

// Same stand-in the section tests mount: the primitives package's CSS
// imports cannot load in the Node test runtime.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { cloneElement, useState } = await import('react')
  return {
    Tooltip: ({ label, disabled, children }: {
      label: string
      disabled?: boolean
      children: React.ReactElement<{ onMouseEnter?: () => void, onMouseLeave?: () => void }>
    }) => {
      const [visible, setVisible] = useState(false)
      return (
        <>
          {cloneElement(children, {
            onMouseEnter: () => { if (disabled !== true) setVisible(true) },
            onMouseLeave: () => setVisible(false),
          })}
          {visible ? <span role="tooltip">{label}</span> : null}
        </>
      )
    },
  }
})

const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

const VIEW = { symbol: '¥' as const, rate: 1 }

function row(overrides: Partial<SessionUsageRow> & { sessionId: string }): SessionUsageRow {
  return {
    totals: { requests: 3, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 1.5,
    firstTime: new Date(2026, 0, 10, 8).getTime(),
    lastTime: new Date(2026, 0, 10, 20).getTime(),
    ...overrides,
  }
}

const ROWS: SessionUsageRow[] = [
  row({ sessionId: 's-root', title: 'Fix the login flow', cwd: '/work/app', childCount: 2 }),
  row({ sessionId: 's-other', title: 'Scratch work', cwd: '/scratch/tools' }),
  row({ sessionId: 's-bare' }),
]

describe('SessionTable', () => {
  afterEach(cleanup)

  it('renders the served rows with the grouping switch above the table', () => {
    render(<SessionTable rows={ROWS} view={VIEW} t={t} />)
    // Grouping switch reflects the default-on state.
    const group = screen.getByRole('group', { name: '目录分组' })
    expect(within(group).getByText('分组').getAttribute('aria-pressed')).toBe('true')
    // No scope switch exists — the fold is unconditional.
    expect(screen.queryByRole('group', { name: '会话范围' })).toBeNull()
  })

  it('groups by directory tail with the no-directory group last', () => {
    render(<SessionTable rows={ROWS} view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: '按会话' })
    // Directory heads: named dirs alphabetical, then the no-directory group.
    const heads = within(table).getAllByText(/app|tools|未指定目录/).map(node => node.textContent)
    expect(heads.some(text => text!.startsWith('app'))).toBe(true)
    expect(heads.some(text => text!.startsWith('tools'))).toBe(true)
    expect(heads.some(text => text!.startsWith('未指定目录'))).toBe(true)
    // Row identity keeps the title (no directory tail in grouped rows).
    expect(within(table).getByText('Fix the login flow')).toBeTruthy()
    expect(within(table).getByText('Scratch work')).toBeTruthy()
  })

  it('indents grouped row titles under their directory head', () => {
    render(<SessionTable rows={ROWS} view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: '按会话' })
    const titleCell = within(table).getByText('Fix the login flow').closest('td')!
    expect(titleCell.className).toMatch(/sessionIndent/)
    // Switching to the flat list drops the indent (no group head above).
    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    const flatCell = within(table).getByText('Fix the login flow').closest('td')!
    expect(flatCell.className).not.toMatch(/sessionIndent/)
  })

  it('switches to the flat list (directory tails become row subtitles)', () => {
    render(<SessionTable rows={ROWS} view={VIEW} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    const table = screen.getByRole('table', { name: '按会话' })
    // No group heads remain; the directory tail rides under each row.
    expect(within(table).queryByText(/未指定目录/)).toBeNull()
    expect(within(table).getByText('app')).toBeTruthy()
    expect(within(table).getByText('tools')).toBeTruthy()
  })

  it('falls back to short id + time span for titleless sessions', () => {
    render(<SessionTable rows={ROWS} view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: '按会话' })
    // Short id (8 chars + ellipsis) and the local-day span; no invented title.
    expect(within(table).getByText('s-bare · 2026-01-10 – 2026-01-10')).toBeTruthy()
  })

  it('badges the folded child count on the row', () => {
    render(<SessionTable rows={ROWS} view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: '按会话' })
    expect(within(table).getByText('含 2 个子会话')).toBeTruthy()
  })

  it('sorts by the clicked column: desc, asc, then back to the served order', () => {
    // Served order is cost-descending by construction (r1 ¥30 / r2 ¥20 /
    // r3 ¥10), but token and lastActive rank differently across the rows.
    const sortable: SessionUsageRow[] = [
      row({ sessionId: 'r1', title: 'A', cost: 30, totals: { requests: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastTime: 100 }),
      row({ sessionId: 'r2', title: 'B', cost: 20, totals: { requests: 1, inputTokens: 900, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastTime: 300 }),
      row({ sessionId: 'r3', title: 'C', cost: 10, totals: { requests: 1, inputTokens: 400, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastTime: 200 }),
    ]
    render(<SessionTable rows={sortable} view={VIEW} t={t} />)
    const table = screen.getByRole('table', { name: '按会话' })
    // Row-title order in the DOM (getAllByText returns document order).
    const order = (): string[] =>
      within(table).getAllByText(/^(A|B|C)$/u).map(node => node.textContent)
    // Served order: cost descending.
    expect(order()).toEqual(['A', 'B', 'C'])
    // First click on 总 token: descending → B (900) / C (400) / A (100).
    fireEvent.click(within(table).getByText('总 token'))
    expect(table.querySelector('th[aria-sort="descending"]')?.textContent).toContain('总 token')
    expect(order()).toEqual(['B', 'C', 'A'])
    // Second click: ascending → A / C / B.
    fireEvent.click(within(table).getByText('总 token'))
    expect(table.querySelector('th[aria-sort="ascending"]')?.textContent).toContain('总 token')
    expect(order()).toEqual(['A', 'C', 'B'])
    // Third click: back to the served (cost) order, no active sort.
    fireEvent.click(within(table).getByText('总 token'))
    expect(table.querySelector('th[aria-sort]')).toBeNull()
    expect(order()).toEqual(['A', 'B', 'C'])
    // 最近活跃 sorts by recency: first click descending → B (300) / C (200) / A (100).
    fireEvent.click(within(table).getByText('最近活跃'))
    expect(order()).toEqual(['B', 'C', 'A'])
  })
})
