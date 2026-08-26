// @vitest-environment jsdom
/**
 * Input-bar quota button rendering tests: the self-gating rules (hidden for
 * no-provider / unsupported / disabled and while loading), the window
 * columns (labels, values, bar widths, aux countdown), the balance row, the
 * error body with its retry, and the ContextMeter-family open/close
 * behavior (toggle, outside pointerdown, Escape). A fake `fetch` answers
 * the payload the host's `/token-usage/quota` route would serve.
 *
 * Fake timers are intentionally NOT enabled for the body-streaming reasons
 * the chip spec documents; the one polling test substitutes the global
 * setInterval/clearInterval pair only.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { QuotaButton, type QuotaButtonProps } from '../src/client/QuotaButton.tsx'
import { zh } from '../src/client/locales.ts'
import type { QuotaPayload } from '../src/wire.ts'

// The tooltip is decoration around the trigger; stubbing it pass-through
// keeps the css inside the primitives package out of the jsdom environment.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
}))

/** zh-bound translate stub, template-replace semantics to match the real chain. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** A stable fetchedAt; the clock stamp is asserted through the same helper. */
const FETCHED_AT = 1_780_000_000_000

/** The two-window coding-plan payload (Zhipu shape). */
const OK_PAYLOAD: QuotaPayload = {
  status: 'ok',
  provider: 'zai-coding-cn',
  providerName: '智谱 GLM Coding Plan',
  adapterId: 'zhipu-coding-plan',
  fetchedAt: FETCHED_AT,
  intervalSec: 60,
  planTier: 'Max',
  windows: [
    { tier: 'five_hour', usedPercent: 62.5, resetAt: Date.now() + 48 * 60_000 },
    { tier: 'weekly', usedPercent: 40, resetAt: Date.now() + 27 * 3_600_000 },
  ],
}

/** A balance payload with a spend total (OpenRouter shape). */
const BALANCE_PAYLOAD: QuotaPayload = {
  status: 'ok',
  provider: 'openrouter',
  providerName: 'OpenRouter',
  adapterId: 'openrouter-credits',
  fetchedAt: FETCHED_AT,
  intervalSec: 60,
  windows: [{ tier: 'balance', remainingValue: 6.8, maxValue: 10, unit: 'usd' }],
}

/** A supported provider whose query failed on auth. */
const ERROR_PAYLOAD: QuotaPayload = {
  status: 'error',
  provider: 'zai-coding-cn',
  providerName: '智谱 GLM Coding Plan',
  adapterId: 'zhipu-coding-plan',
  fetchedAt: FETCHED_AT,
  intervalSec: 60,
  error: { kind: 'auth', message: 'HTTP 401' },
}

const NO_PROVIDER: QuotaPayload = { status: 'no-provider', intervalSec: 60 }
const UNSUPPORTED: QuotaPayload = { status: 'unsupported', provider: 'anthropic', intervalSec: 60 }
const DISABLED: QuotaPayload = { status: 'disabled', intervalSec: 60 }

/** Props the slot renderer binds (the runtime kit is cast through — the
 * button reads sessionId + t + the optional model-directory holder). */
function propsOf(sessionId = 's1', modelDirectory?: { service: unknown }): QuotaButtonProps {
  return { sessionId, t, ...(modelDirectory !== undefined ? { modelDirectory } : {}) } as QuotaButtonProps
}

/** A fake model-directory holder answering one live chip selection. */
function modelDirectoryOf(initial: string | undefined): {
  handle: { service: unknown }
  select(provider: string | undefined): void
} {
  let current = initial
  const listeners = new Set<() => void>()
  const service = {
    directoryFor: () => ({
      store: {
        getSnapshot: (): { current: { provider: string } | null } =>
          current === undefined ? { current: null } : { current: { provider: current } },
        subscribe: (fn: () => void): (() => void) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      },
    }),
  }
  return {
    handle: { service },
    select(provider: string | undefined): void {
      current = provider
      for (const fn of [...listeners]) fn()
    },
  }
}

/** Stub global fetch with a static JSON payload. */
function stubFetch(payload: QuotaPayload): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('QuotaButton', () => {
  it('renders nothing while the first fetch is in flight', () => {
    stubFetch(OK_PAYLOAD)
    const { container } = render(<QuotaButton {...propsOf()} />)
    expect(container.firstChild).toBeNull()
  })

  it.each([
    ['no-provider', NO_PROVIDER],
    ['unsupported', UNSUPPORTED],
    ['disabled', DISABLED],
  ])('renders nothing for the %s variant', async (name, payload) => {
    expect(name).toBeTruthy()
    stubFetch(payload)
    const { container } = render(<QuotaButton {...propsOf()} />)
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })

  it('renders the trigger for an ok payload and opens the panel with the window columns', async () => {
    stubFetch(OK_PAYLOAD)
    render(<QuotaButton {...propsOf()} />)
    const trigger = await screen.findByLabelText('供应商配额')
    fireEvent.click(trigger)
    // Header: provider name + plan tier + updated stamp.
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('智谱 GLM Coding Plan')
    expect(panel.textContent).toContain('Max')
    // Column labels and values — the figures carry the REMAINING share.
    expect(screen.getByText('5 小时')).not.toBeNull()
    expect(screen.getByText('每周')).not.toBeNull()
    expect(screen.getByText('37.5%')).not.toBeNull()
    expect(screen.getByText('60%')).not.toBeNull()
    // The first bar carries the five-hour remaining share (rounded),
    // yellow by the traffic light (37.5% remaining sits in 20–60).
    const fills = panel.querySelectorAll('[class*="fill"]')
    expect(fills.length).toBeGreaterThanOrEqual(1)
    expect((fills[0] as HTMLElement).style.width).toBe('38%')
    expect(fills[0]?.className).toMatch(/warn/)
    // Aux rows carry the reset countdown (shape, not the exact minute).
    const aux = panel.querySelectorAll('[class*="aux"]')
    expect(aux.length).toBeGreaterThanOrEqual(1)
    expect(aux[0]?.textContent).toMatch(/后重置$/)
  })

  it('renders a balance row with the amount, its total, and no reset countdown', async () => {
    stubFetch(BALANCE_PAYLOAD)
    render(<QuotaButton {...propsOf()} />)
    fireEvent.click(await screen.findByLabelText('供应商配额'))
    expect(screen.getByText('余额')).not.toBeNull()
    expect(screen.getByText(/\$6\.80/)).not.toBeNull()
    expect(screen.getByText(/\/ \$10\.00/)).not.toBeNull()
    // The bar carries the REMAINING share (6.8/10 = 68%, green band).
    const panel = screen.getByRole('dialog')
    const fill = panel.querySelector('[class*="fill"]') as HTMLElement | null
    expect(fill?.style.width).toBe('68%')
    expect(fill?.className).toMatch(/ok/)
    expect(panel.querySelector('[class*="aux"]')).toBeNull()
  })

  it('paints the trigger with the exhausted severity class at <20% remaining', async () => {
    const exhausted: QuotaPayload = {
      ...OK_PAYLOAD,
      windows: [{ tier: 'five_hour', usedPercent: 97, resetAt: Date.now() + 10 * 60_000 }],
    }
    stubFetch(exhausted)
    render(<QuotaButton {...propsOf()} />)
    const trigger = await screen.findByLabelText('供应商配额')
    expect(trigger.className).toMatch(/exhausted/)
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    expect(panel.querySelector('[class*="fill"][class*="exhausted"]')).not.toBeNull()
  })

  it('keeps the button on an error payload and shows the friendly copy with a retry', async () => {
    const fetchMock = stubFetch(ERROR_PAYLOAD)
    render(<QuotaButton {...propsOf()} />)
    const trigger = await screen.findByLabelText('供应商配额')
    // No window to fill — the track sits empty until a retry succeeds.
    expect(trigger.querySelectorAll('circle')).toHaveLength(1)
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('鉴权失败（HTTP 401）')
    // Retry refetches.
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('tiers the panel width: amount-only 200, one bar 232, two bars 320', async () => {
    // Amount-only (the DeepSeek shape): no computable ratio → the minimal
    // plate, the figure reads at a glance.
    stubFetch({
      status: 'ok', provider: 'deepseek-official', providerName: 'DeepSeek',
      adapterId: 'deepseek-balance', fetchedAt: FETCHED_AT, intervalSec: 60,
      windows: [{ tier: 'balance', remainingValue: 110.5, unit: 'cny' }],
    })
    const amountOnly = render(<QuotaButton {...propsOf()} />)
    fireEvent.click(await screen.findByLabelText('供应商配额'))
    expect((screen.getByRole('dialog') as HTMLElement).style.width).toBe('200px')
    amountOnly.unmount()

    // One bar — a balance with a spend total (the OpenRouter shape) or a
    // weekly-only plan — reads the middle plate.
    stubFetch(BALANCE_PAYLOAD)
    const oneBar = render(<QuotaButton {...propsOf()} />)
    fireEvent.click(await screen.findByLabelText('供应商配额'))
    expect((screen.getByRole('dialog') as HTMLElement).style.width).toBe('232px')
    oneBar.unmount()

    // Two bars (5-hour + weekly) and error bodies keep the full plate.
    stubFetch(OK_PAYLOAD)
    render(<QuotaButton {...propsOf()} />)
    fireEvent.click(await screen.findByLabelText('供应商配额'))
    expect((screen.getByRole('dialog') as HTMLElement).style.width).toBe('320px')
  })

  it('paints the trigger from the finest window; an absolute amount stays neutral when funded', async () => {
    stubFetch({
      ...OK_PAYLOAD,
      windows: [
        // The 5-hour window is the finest unit and it is healthy — the
        // icon reads GREEN even though the weekly pool is exhausted.
        { tier: 'five_hour', usedPercent: 5, resetAt: Date.now() + 60_000 },
        { tier: 'weekly', usedPercent: 97, resetAt: Date.now() + 3_600_000 },
      ],
    })
    const ringC = 2 * Math.PI * 5.5
    const healthy = render(<QuotaButton {...propsOf()} />)
    const trigger = await screen.findByLabelText('供应商配额')
    expect(trigger.className).toMatch(/icon-ok/)
    expect(trigger.className).not.toMatch(/exhausted/)
    // Remaining-share ring: used 5% → 95% left, two circles (track + fill).
    expect(trigger.querySelectorAll('circle')).toHaveLength(2)
    expect(trigger.querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray'))
      .toBe(`${(0.95 * ringC).toFixed(3)} ${ringC.toFixed(3)}`)
    healthy.unmount()

    // A ratio-less amount (the DeepSeek shape) never tints the healthy
    // icon — amounts color only at ≤ 0 (red).
    stubFetch({
      status: 'ok', provider: 'deepseek-official', providerName: 'DeepSeek',
      adapterId: 'deepseek-balance', fetchedAt: FETCHED_AT, intervalSec: 60,
      windows: [{ tier: 'balance', remainingValue: 110.5, unit: 'cny' }],
    })
    render(<QuotaButton {...propsOf()} />)
    const funded = await screen.findByLabelText('供应商配额')
    expect(funded.className).not.toMatch(/icon-/)
    // A funded amount without a total still paints a full (neutral) ring.
    expect(funded.querySelectorAll('circle')).toHaveLength(2)
    expect(funded.querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray'))
      .toBe(`${ringC.toFixed(3)} ${ringC.toFixed(3)}`)
  })

  it('closes on outside pointerdown and on Escape', async () => {
    stubFetch(OK_PAYLOAD)
    render(<QuotaButton {...propsOf()} />)
    fireEvent.click(await screen.findByLabelText('供应商配额'))
    expect(screen.getByRole('dialog')).not.toBeNull()
    // A pointerdown inside the root keeps the panel open.
    fireEvent.pointerDown(screen.getByText('5 小时'))
    expect(screen.getByRole('dialog')).not.toBeNull()
    // Outside closes.
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Reopen, then Escape closes.
    fireEvent.click(screen.getByLabelText('供应商配额'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('centers the panel on the button and nudges it inside the viewport', async () => {
    stubFetch(OK_PAYLOAD)
    const { container } = render(<QuotaButton {...propsOf()} />)
    const trigger = await screen.findByLabelText('供应商配额')
    // A realistic right-cluster seat: a 28px button, 700px from the left of
    // the 1024px viewport (jsdom's zero rect could not express centering).
    const wrapper = container.firstChild as HTMLElement
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ left: 700, width: 28 } as DOMRect)
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog') as HTMLElement
    // Centered on the button: (28 - 320) / 2 relative to the wrapper.
    expect(panel.style.left).toBe('-146px')
    // A viewport narrower than panel + margins slides the panel to the
    // 16px left margin (16 - 700 relative to the wrapper).
    act(() => {
      window.innerWidth = 300
      window.dispatchEvent(new Event('resize'))
    })
    expect(panel.style.left).toBe('-684px')
    window.innerWidth = 1024
  })

  it('scopes each fetch to the session and follows the served cadence', async () => {
    const fetchMock = stubFetch(OK_PAYLOAD)
    render(<QuotaButton {...propsOf('session-7')} />)
    await screen.findByLabelText('供应商配额')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/token-usage/quota?session=session-7')
    // The payload's intervalSec (60) drives the poll cadence.
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('names the chip-selected provider in the fetch, before any request', async () => {
    const fetchMock = stubFetch(OK_PAYLOAD)
    const chip = modelDirectoryOf('minimax')
    render(<QuotaButton {...propsOf('s1', chip.handle)} />)
    await screen.findByLabelText('供应商配额')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/token-usage/quota?session=s1&provider=minimax')
  })

  it('refetches when the chip selection switches providers', async () => {
    const fetchMock = stubFetch(OK_PAYLOAD)
    const chip = modelDirectoryOf('zai-coding-cn')
    render(<QuotaButton {...propsOf('s1', chip.handle)} />)
    await waitFor(() => {
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/token-usage/quota?session=s1&provider=zai-coding-cn')
    })
    // Switching the chip re-renders through the store listener and the
    // next fetch names the new provider (act wraps the store notification
    // so the listener's state update flushes inside the test).
    act(() => { chip.select('minimax') })
    await waitFor(() => {
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/token-usage/quota?session=s1&provider=minimax')
    })
  })

  it('survives a model-directory service that throws for the session', async () => {
    const fetchMock = stubFetch(OK_PAYLOAD)
    const hostile = {
      handle: {
        service: {
          directoryFor: (): never => {
            throw new Error('no scope')
          },
        },
      },
    }
    render(<QuotaButton {...propsOf('s1', hostile.handle)} />)
    await screen.findByLabelText('供应商配额')
    // No provider hint — the fetch carries the session alone.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/token-usage/quota?session=s1')
  })
})
