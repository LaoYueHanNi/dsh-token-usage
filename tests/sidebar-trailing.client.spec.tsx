// @vitest-environment jsdom
/**
 * Sidebar trailing badge: the visible figure (today's cost · token), the
 * collapsed rail's cost-only mark, the empty-today rule, the unpriced-cost
 * fallback, and the totals-only request shape it polls.
 *
 * Real timers only (jsdom + Response body parsing); the first read lands
 * through `findByText`.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarTrailing, shortCost } from '../src/client/SidebarTrailing.tsx'
import { dayKeyOf } from '../src/client/day.ts'
import type { WholeChipSummary } from '../src/wire.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TODAY = dayKeyOf(new Date())

function chip(overrides: Partial<WholeChipSummary> = {}): WholeChipSummary {
  return {
    scope: 'whole',
    total: {
      requests: 3,
      inputTokens: 1_000_000,
      outputTokens: 240_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    totalCost: 12.4,
    unpricedModels: [],
    costState: 'ready',
    currency: 'CNY',
    usdExchangeRate: 7,
    ...overrides,
  }
}

function stubFetch(payload: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('sidebar trailing badge', () => {
  it('renders today\'s cost and total token in the expanded row', async () => {
    const fetchMock = stubFetch(chip())
    const { container } = render(<SidebarTrailing {...({ wide: true } as never)} />)
    expect(await screen.findByText('12.40￥')).toBeTruthy()
    expect(screen.getByText('1.2M')).toBeTruthy()
    expect(container.textContent).toContain('·')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('from=' + TODAY)
    expect(url).toContain('to=' + TODAY)
    expect(url).toContain('fields=chip')
  })

  it('the collapsed rail carries the short cost mark only', async () => {
    stubFetch(chip({ totalCost: 12.4 }))
    render(<SidebarTrailing {...({ wide: false } as never)} />)
    expect(await screen.findByText('12￥')).toBeTruthy()
    expect(screen.queryByText('1.2M')).toBeNull()
  })

  it('renders nothing when today has no recorded requests', async () => {
    stubFetch(chip({ total: { ...chip().total, requests: 0 } }))
    const { container } = render(<SidebarTrailing {...({ wide: true } as never)} />)
    // Let the first read settle before asserting the empty render.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(container.childElementCount).toBe(0)
  })

  it('shows an unknown cost (—) when pricing is unavailable, keeping the token figure', async () => {
    stubFetch(chip({ costState: 'pricing-unavailable' }))
    render(<SidebarTrailing {...({ wide: true } as never)} />)
    expect(await screen.findByText('—')).toBeTruthy()
    expect(screen.getByText('1.2M')).toBeTruthy()
  })

  it('renders nothing while the first read fails, and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { container } = render(<SidebarTrailing {...({ wide: true } as never)} />)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(container.childElementCount).toBe(0)
  })

  it('rejects a payload of the wrong shape without painting it', async () => {
    stubFetch({ scope: 'session', total: {}, totalCost: 1, currency: 'CNY' })
    const { container } = render(<SidebarTrailing {...({ wide: true } as never)} />)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(container.childElementCount).toBe(0)
  })
})

describe('shortCost', () => {
  const cny = { symbol: '￥' as const, rate: 1 }
  const usd = { symbol: '$' as const, rate: 7 }

  it('rounds above ten units and keeps one decimal below', () => {
    expect(shortCost(12.4, cny)).toBe('12￥')
    expect(shortCost(120.6, cny)).toBe('121￥')
    expect(shortCost(8.04, cny)).toBe('8￥')
    expect(shortCost(0.18, cny)).toBe('0.2￥')
  })

  it('converts through the USD view before shortening', () => {
    expect(shortCost(84, usd)).toBe('12$')
    expect(shortCost(1.4, usd)).toBe('0.2$')
  })
})