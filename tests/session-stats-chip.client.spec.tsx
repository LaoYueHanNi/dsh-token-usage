// @vitest-environment jsdom
/**
 * Session-header stats chip rendering tests: the spec's two visible rules
 * (data present → three cells in order; data absent → nothing renders) and
 * the live-update plumbing (request-scale refresh via session-mirror
 * `updatedAt`, a transport failure leaves the previous render in place, a
 * failed FIRST fetch retries itself, reduced-motion stays silent).
 * The hit-rate bucket classes are pinned because they drive the color
 * thresholds. A fake `fetch` answers the per-session summary the host's
 * `/token-usage/stats?sessionId=<id>` route would serve.
 *
 * Real timers only — fake timers break jsdom's Response body parsing
 * (streams schedule on real timers). Debounce waits use `waitFor` with a
 * timeout past the 250 ms refresh window.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import { SessionStatsChip, FETCH_FAILURE_RETRY_MS, type SessionStatsChipProps } from '../src/client/SessionStatsChip.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageSummary } from '../src/wire.ts'
import { makeUseProjection, useSessionsFromState } from './test-kit.ts'

/** zh-bound translate stub, template-replace semantics to match the real chain. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** One ready summary (the values are picked so every assertion has a
 * distinct figure: total tokens 1.5M, hit rate 80%, cost ¥12.34). The
 * hit-rate denominator is `inputTokens + cacheReadTokens`, so 400k/500k
 * lands at 80% — exactly the `lime`/`amber` boundary, so the chip drops
 * into the lime bucket; the total token count stays under 1B and rounds
 * cleanly under formatTokens. */
const READY_SUMMARY: UsageSummary = {
  dataDir: 'C:/data/token-usage',
  currency: 'CNY',
  usdExchangeRate: 7,
  total: {
    requests: 10, inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 400_000, cacheWriteTokens: 950_000,
  },
  totalCost: 12.34,
  unpricedModels: [],
  pricing: {},
  byDay: [],
  byHour: [],
  byModel: [],
  rateRows: [],
  recent: [],
}

/** An empty summary: a session with no recorded requests. */
const EMPTY_SUMMARY: UsageSummary = {
  ...READY_SUMMARY,
  total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  totalCost: 0,
}

/** A summary whose cache reads drive the rate to ≥95% (healthy bucket). */
const HEALTHY_SUMMARY: UsageSummary = {
  ...READY_SUMMARY,
  total: { requests: 10, inputTokens: 10_000, outputTokens: 50_000, cacheReadTokens: 360_000, cacheWriteTokens: 100_000 },
}

/** A summary whose cache reads drive the rate below 60% (critical bucket). */
const CRITICAL_SUMMARY: UsageSummary = {
  ...READY_SUMMARY,
  total: { requests: 10, inputTokens: 500_000, outputTokens: 50_000, cacheReadTokens: 10_000, cacheWriteTokens: 100_000 },
}

/** A later summary used to assert request-driven refreshes repaint figures. */
const UPDATED_SUMMARY: UsageSummary = {
  ...READY_SUMMARY,
  total: {
    requests: 11, inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 950_000,
  },
  totalCost: 20,
}

/** Live sessionStats for the active session (bumps each request step). */
const LIVE_STATS: SessionStatsProjection = {
  turns: 1, steps: 5, llmMs: 1_000, toolMs: 0, ttftMs: 100, ttftSteps: 2, decodeMs: 500, decodeTokens: 200,
}

/** Build the props the slot renderer binds for the chip. An empty `byId`
 * (the default) means "no known children", so the fetch stays on the one
 * session id — the no-subagent case the original chip always hit. */
function propsOf(
  sessionId: string,
  byId: SessionListState['byId'] = {},
  liveStats: SessionStatsProjection | undefined = LIVE_STATS,
): SessionStatsChipProps {
  return {
    sessionId,
    t,
    useProjection: makeUseProjection(liveStats),
    useSessions: useSessionsFromState({
      ids: Object.keys(byId),
      byId,
      current: sessionId,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    } as SessionListState),
  } as SessionStatsChipProps
}

/** Solo session row used when a test needs to bump `updatedAt`. */
const SOLO_BY_ID: SessionListState['byId'] = {
  'session-a': { id: 'session-a', displayTitle: 'Solo', parentId: undefined, blank: false, running: false, updatedAt: 1 },
}

/** matchMedia fake answering only the reduce query as matched (jsdom has
 * no matchMedia of its own; the chip's other paths never call it). */
function stubReducedMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }))
}

/** A root with one direct subagent (and a nested grandchild in NESTED_BY_ID). */
const TREE_BY_ID: SessionListState['byId'] = {
  'session-a': { id: 'session-a', displayTitle: 'Parent', parentId: undefined, blank: false, running: false, updatedAt: 1 },
  child: { id: 'child', displayTitle: 'Child', parentId: 'session-a', origin: 'subagent', blank: false, running: false, updatedAt: 2 },
}

const NESTED_BY_ID: SessionListState['byId'] = {
  ...TREE_BY_ID,
  grandchild: { id: 'grandchild', displayTitle: 'Grandchild', parentId: 'child', origin: 'subagent', blank: false, running: false, updatedAt: 3 },
}

/** Stub global fetch with a static JSON payload (or a sequence for layered tests). */
function stubFetch(payload: UsageSummary | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (payload instanceof Error) throw payload
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Stub fetch with a queue of payloads (or Errors) consumed in order. */
function stubFetchSequence(payloads: ReadonlyArray<UsageSummary | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const next = payloads.shift()
    if (next === undefined) throw new Error('no more payloads')
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionStatsChip', () => {
  it('renders nothing before the first fetch lands (empty rule: no blanking)', () => {
    stubFetch(READY_SUMMARY)
    const { container } = render(<SessionStatsChip {...propsOf('s1')} />)
    // The strip is absent from the document until the first fetch settles.
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the session has zero recorded requests', async () => {
    stubFetch(EMPTY_SUMMARY)
    const { container } = render(<SessionStatsChip {...propsOf('s1')} />)
    // The fetch resolves asynchronously; wait for it, then re-check.
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })

  it('renders the three cells in order once data arrives', async () => {
    stubFetch(READY_SUMMARY)
    render(<SessionStatsChip {...propsOf('s1')} />)
    // Token cell (1.5M total).
    const tokens = await screen.findByLabelText('含子会话 token 用量 1.5M')
    expect(tokens.textContent).toBe('1.5M')
    // Hit-rate cell — 80% (300k / 500k served).
    const hit = screen.getByLabelText('含子会话缓存命中率 80%')
    expect(hit.textContent).toBe('80%')
    // Cost cell.
    const cost = screen.getByLabelText('含子会话费用 ¥12.34')
    expect(cost.textContent).toBe('¥12.34')
  })

  it('paints the hit-rate cell with the healthy bucket class at ≥95%', async () => {
    stubFetch(HEALTHY_SUMMARY)
    const { container } = render(<SessionStatsChip {...propsOf('s1')} />)
    await screen.findByLabelText(/含子会话缓存命中率 97\.3%/)
    // The cell that owns the band class sits in the rendered strip — the
    // band key is the class's suffix, not its hash, so we read by suffix.
    const healthyCell = container.querySelector('[class*="band_healthy"]')
    expect(healthyCell).not.toBeNull()
    expect(healthyCell?.textContent).toBe('97.3%')
  })

  it('paints the hit-rate cell with the critical bucket class at <60%', async () => {
    stubFetch(CRITICAL_SUMMARY)
    const { container } = render(<SessionStatsChip {...propsOf('s1')} />)
    await screen.findByLabelText(/含子会话缓存命中率/)
    const criticalCell = container.querySelector('[class*="band_critical"]')
    expect(criticalCell).not.toBeNull()
    expect(criticalCell?.textContent).toMatch(/%$/)
  })

  it('does not blank the strip when a request-driven refresh fails (keeps the previous summary)', async () => {
    // First call lands with READY_SUMMARY, second call rejects. The chip
    // must keep the first render — a transient miss never blanks the bar.
    const fetchMock = stubFetchSequence([READY_SUMMARY, new Error('network down')])
    const { rerender, container } = render(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID)} />)
    await waitFor(() => {
      expect(container.firstChild).not.toBeNull()
    })
    expect(screen.getByLabelText('含子会话 token 用量 1.5M')).not.toBeNull()
    // A finished request bumps updatedAt → debounced refetch; the failure
    // must leave the previous figures on screen.
    rerender(<SessionStatsChip {...propsOf('session-a', {
      'session-a': { ...SOLO_BY_ID['session-a']!, updatedAt: 2 },
    })} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(screen.getByLabelText('含子会话 token 用量 1.5M')).not.toBeNull()
  })

  it('refetches when the scoped session updatedAt advances (request granularity)', async () => {
    const fetchMock = stubFetchSequence([READY_SUMMARY, UPDATED_SUMMARY])
    const { rerender, container } = render(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID)} />)
    await screen.findByLabelText('含子会话 token 用量 1.5M')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerender(<SessionStatsChip {...propsOf('session-a', {
      'session-a': { ...SOLO_BY_ID['session-a']!, updatedAt: 2 },
    })} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    // 1.65M rounds under formatTokens to 1.6M; cost proves the new payload.
    expect(await screen.findByLabelText('含子会话 token 用量 1.6M')).not.toBeNull()
    expect(screen.getByLabelText('含子会话费用 ¥20.00')).not.toBeNull()
    await waitFor(() => {
      expect(container.querySelector('[class*="deltaFly"]')?.textContent).toBe('+¥7.66')
    }, { timeout: 200 })
    // jsdom ships no Web Animations API: the fly label mounts (so the text
    // is assertable) but hides itself instead of sitting statically for the
    // whole inflate window — the no-WAAPI graceful degradation.
    const fly = container.querySelector<HTMLElement>('[class*="deltaFly"]')
    expect(fly?.style.visibility).toBe('hidden')
  })

  it('keeps reduced-motion updates silent: no fly label, figures still repaint', async () => {
    stubReducedMotion()
    const fetchMock = stubFetchSequence([READY_SUMMARY, UPDATED_SUMMARY])
    const { rerender, container } = render(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID)} />)
    await screen.findByLabelText('含子会话 token 用量 1.5M')
    rerender(<SessionStatsChip {...propsOf('session-a', {
      'session-a': { ...SOLO_BY_ID['session-a']!, updatedAt: 2 },
    })} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(await screen.findByLabelText('含子会话费用 ¥20.00')).not.toBeNull()
    // No pop, no fly: the strip never even opens its overflow.
    expect(container.querySelector('[class*="deltaFly"]')).toBeNull()
  })

  it('recovers by itself when the first fetch fails (no poll to lean on)', async () => {
    const fetchMock = stubFetchSequence([new Error('startup hiccup'), READY_SUMMARY])
    const { container } = render(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID)} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    // Failed first load renders nothing while the retry is pending.
    expect(container.firstChild).toBeNull()
    // The chip retries itself on the failure cadence; the retry lands and
    // the strip appears without any mirror churn in between.
    await waitFor(
      () => { expect(fetchMock).toHaveBeenCalledTimes(2) },
      { timeout: FETCH_FAILURE_RETRY_MS + 2_000 },
    )
    expect(await screen.findByLabelText('含子会话 token 用量 1.5M')).not.toBeNull()
  }, 10_000)

  it('refetches when live sessionStats advances without updatedAt churn', async () => {
    const fetchMock = stubFetchSequence([READY_SUMMARY, UPDATED_SUMMARY])
    const { rerender } = render(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID)} />)
    await screen.findByLabelText('含子会话 token 用量 1.5M')
    rerender(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID, {
      ...LIVE_STATS,
      steps: LIVE_STATS.steps + 1,
      decodeTokens: LIVE_STATS.decodeTokens + 100,
    })} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(await screen.findByLabelText('含子会话 token 用量 1.6M')).not.toBeNull()
  })

  it('does not refetch while the session mirror is idle', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    render(<SessionStatsChip {...propsOf('session-a', SOLO_BY_ID)} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Well past the 250 ms debounce: no mirror churn → no extra fetch.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('scopes each fetch to the active session id', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    render(<SessionStatsChip {...propsOf('session-a')} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/token-usage/stats?sessionId=session-a&fields=chip')
  })

  it('folds the subagent subtree into the chip fetch (parent + children)', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    render(<SessionStatsChip {...propsOf('session-a', TREE_BY_ID)} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/token-usage/stats?sessionId=session-a&sessionId=child&fields=chip',
    )
  })

  it('includes nested grandchildren in the chip fetch', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    render(<SessionStatsChip {...propsOf('session-a', NESTED_BY_ID)} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/token-usage/stats?sessionId=session-a&sessionId=child&sessionId=grandchild&fields=chip',
    )
  })

  it('refetches with the new child id when a subagent appears after mount', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    const { rerender } = render(<SessionStatsChip {...propsOf('session-a')} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/token-usage/stats?sessionId=session-a&fields=chip')
    rerender(<SessionStatsChip {...propsOf('session-a', TREE_BY_ID)} />)
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string | undefined
      expect(lastCall).toBe(
        '/token-usage/stats?sessionId=session-a&sessionId=child&fields=chip',
      )
    })
  })

  it('refetches for the new session id and does not keep polling the old one', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    const { rerender } = render(<SessionStatsChip {...propsOf('session-a')} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    const sessionACallsBeforeRerender = fetchMock.mock.calls
      .filter(call => String(call[0]).includes('sessionId=session-a')).length
    expect(sessionACallsBeforeRerender).toBeGreaterThan(0)
    rerender(<SessionStatsChip {...propsOf('session-b')} />)
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string | undefined
      expect(lastCall).toBe('/token-usage/stats?sessionId=session-b&fields=chip')
    })
    const afterSwitch = fetchMock.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(fetchMock.mock.calls.length).toBe(afterSwitch)
    const sessionACallsAfter = fetchMock.mock.calls
      .filter(call => String(call[0]).includes('sessionId=session-a')).length
    expect(sessionACallsAfter).toBe(sessionACallsBeforeRerender)
  })
})
