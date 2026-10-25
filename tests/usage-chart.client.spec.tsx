// @vitest-environment jsdom
/** DOM contract of the line/activity switch and the bricks' mount-only WAAPI. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageDayRow } from '../src/wire.ts'
import { TokenActivity } from '../src/client/TokenActivity.tsx'
import { UsageChart } from '../src/client/UsageChart.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

function dayRow(day: string, tokens: number): UsageDayRow {
  return { day, totals: { requests: tokens > 0 ? 1 : 0, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

const ROWS = [
  dayRow('2026-02-26', 10),
  dayRow('2026-02-27', 20),
  dayRow('2026-03-01', 30),
  dayRow('2026-03-02', 40),
  dayRow('2026-03-04', 60),
]
const RANGE = { from: '2026-02-26', to: '2026-03-04' } as const
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

function stubAnimate(): {
  options: Array<number | KeyframeAnimationOptions | undefined>
  animations: Array<{ cancel: ReturnType<typeof vi.fn> }>
} {
  const options: Array<number | KeyframeAnimationOptions | undefined> = []
  const animations: Array<{ cancel: ReturnType<typeof vi.fn> }> = []
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: vi.fn((_keyframes: unknown, nextOptions?: number | KeyframeAnimationOptions) => {
      options.push(nextOptions)
      const animation = { cancel: vi.fn() }
      animations.push(animation)
      return animation
    }),
  })
  return { options, animations }
}

afterEach(() => {
  cleanup()
  if (originalAnimate === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  else Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, 'matchMedia')
  else Object.defineProperty(window, 'matchMedia', originalMatchMedia)
})

describe('UsageChart', () => {
  it('switches between the unchanged line and daily/weekly/cumulative activity readings', () => {
    render(<UsageChart rows={ROWS} {...RANGE} t={t} />)
    expect(screen.getByRole('img', { name: '每日总 token 曲线' })).toBeTruthy()

    const bricksButton = screen.getByRole('button', { name: '砖块' })
    fireEvent.click(bricksButton)
    expect(bricksButton.getAttribute('aria-pressed')).toBe('true')
    const daily = screen.getByRole('group', { name: '每日 token 活动砖块图' })
    expect(within(daily).getAllByRole('img')).toHaveLength(7)
    expect(within(daily).getByLabelText('2026-02-28 总量 0').getAttribute('data-level')).toBe('0')
    expect(screen.queryByRole('img', { name: '每日总 token 曲线' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '每周' }))
    const weekly = screen.getByRole('group', { name: '每周 token 活动砖块图' })
    expect(within(weekly).getByLabelText('2026-02-26 所在周（2026-02-26 至 2026-03-01）总量 60')).toBeTruthy()
    expect(within(weekly).getByLabelText('2026-03-04 所在周（2026-03-02 至 2026-03-04）总量 100')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '累计总量' }))
    const cumulative = screen.getByRole('group', { name: '累计 token 活动砖块图' })
    expect(within(cumulative).getByLabelText('2026-03-04 累计总量 160')).toBeTruthy()
    expect(screen.getByRole('button', { name: '累计总量' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '折线' }))
    expect(screen.getByRole('img', { name: '每日总 token 曲线' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '累计 token 活动砖块图' })).toBeNull()
  })
})

describe('TokenActivity motion', () => {
  it('staggers bricks oldest-to-newest, does not replay updates, and cancels on unmount', () => {
    const { options, animations } = stubAnimate()
    const { rerender, unmount } = render(<TokenActivity rows={ROWS} {...RANGE} t={t} />)
    expect(options.map(option => (option as KeyframeAnimationOptions).delay)).toEqual([24, 32, 40, 48, 56, 64, 72])
    expect(options.every(option => (option as KeyframeAnimationOptions).duration === 260)).toBe(true)
    expect(options.every(option => (option as KeyframeAnimationOptions).fill === 'backwards')).toBe(true)

    const callCount = animations.length
    rerender(<TokenActivity rows={ROWS.map((row, index) => index === 0 ? dayRow(row.day, 999) : row)} {...RANGE} t={t} />)
    expect(animations).toHaveLength(callCount)

    // A reading change intentionally remounts and replays the new sequence.
    rerender(<TokenActivity rows={ROWS} {...RANGE} mode="cumulative" t={t} />)
    expect(animations.length).toBe(callCount * 2)
    unmount()
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
  })

  it('caps the stagger for long ranges', () => {
    const { options } = stubAnimate()
    render(<TokenActivity rows={[dayRow('2026-01-01', 1), dayRow('2026-12-31', 2)]} t={t} />)
    const delays = options.map(option => Number((option as KeyframeAnimationOptions).delay))
    expect(Math.max(...delays)).toBe(960)
  })

  it('renders statically when reduced motion is requested', () => {
    const { options } = stubAnimate()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({ matches: true })),
    })
    render(<TokenActivity rows={ROWS} {...RANGE} t={t} />)
    expect(options).toHaveLength(0)
    expect(screen.getByRole('group', { name: '每日 token 活动砖块图' })).toBeTruthy()
    expect(screen.getAllByRole('img')).toHaveLength(7)
  })

  it('renders the shared empty hint without a calendar', () => {
    render(<TokenActivity rows={[]} t={t} />)
    expect(screen.getByText('区间内暂无数据')).toBeTruthy()
    expect(screen.queryByRole('group', { name: '每日 token 活动砖块图' })).toBeNull()
  })
})
