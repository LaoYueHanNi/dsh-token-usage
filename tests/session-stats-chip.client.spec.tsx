// @vitest-environment jsdom
/**
 * Session-header stats chip rendering tests: the spec's two visible rules
 * (data present → three cells in order; data absent → nothing renders) and
 * the live-update plumbing (the poll resets when the active session id
 * changes, a transport failure leaves the previous render in place). The
 * hit-rate bucket classes are pinned because they drive the color
 * thresholds. A fake `fetch` answers the per-session summary the host's
 * `/token-usage/stats?sessionId=<id>` route would serve.
 *
 * Fake timers are intentionally NOT enabled — they break jsdom's Response body
 * parsing (streams schedule on real timers). The polling tests instead
 * substitute the global `setInterval`/`clearInterval` so a tick can be
 * triggered deterministically without freezing the microtask queue.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionStatsChip, type SessionStatsChipProps } from '../src/client/SessionStatsChip.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageSummary } from '../src/wire.ts'
import { useSessionsFromState } from './test-kit.ts'

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

/** Build the props the slot renderer binds for the chip. An empty `byId`
 * (the default) means "no known children", so the fetch stays on the one
 * session id — the no-subagent case the original chip always hit. */
function propsOf(
  sessionId: string,
  byId: SessionListState['byId'] = {},
): SessionStatsChipProps {
  return {
    sessionId,
    t,
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

beforeEach(() => {
  // Replace the global setInterval/clearInterval so a poll tick can be
  // advanced by hand. We must NOT replace setTimeout, clearTimeout,
  // setImmediate, or the timer that drives @response body streaming — the
  // mocked fetch's Response body parsing depends on those still firing on
  // real wall time.
  // NOTE: tests in this file can be flaky if vi.useFakeTimers interferes
  // with the React act/microtask queue; callers that only test the no-poll
  // paths can override per-test with vi.useRealTimers().
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

  it('does not blank the strip when a poll tick fails (keeps the previous summary)', async () => {
    // First call lands with READY_SUMMARY, second call rejects. The chip
    // must keep the first render — a transient miss never blanks the bar.
    const fetchMock = stubFetchSequence([READY_SUMMARY, new Error('network down')])
    const { container } = render(<SessionStatsChip {...propsOf('s1')} />)
    // Yield once to let the first fetch + setState complete, then check.
    await waitFor(() => {
      expect(container.firstChild).not.toBeNull()
    })
    // The first render must already show the right label.
    expect(screen.getByLabelText('含子会话 token 用量 1.5M')).not.toBeNull()
    // Advance the polling timer so the second fetch fires; the chip must
    // stay rendered (a transient miss never blanks the bar).
    await vi.advanceTimersByTimeAsync(3_000)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    // The first render survives: the same aria-label still resolves.
    expect(screen.getByLabelText('含子会话 token 用量 1.5M')).not.toBeNull()
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

  it('cancels the previous poll when the session id changes', async () => {
    const fetchMock = stubFetch(READY_SUMMARY)
    const { rerender } = render(<SessionStatsChip {...propsOf('session-a')} />)
    await screen.findByLabelText(/含子会话 token 用量/)
    // Snapshot the initial fetch count for session-a before the rerender.
    const sessionACallsBeforeRerender = fetchMock.mock.calls
      .filter(call => String(call[0]).includes('sessionId=session-a')).length
    expect(sessionACallsBeforeRerender).toBeGreaterThan(0)
    // Switch the session id: the previous poll must clear, the new one must
    // start fresh (its first fetch carries the new id).
    rerender(<SessionStatsChip {...propsOf('session-b')} />)
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string | undefined
      expect(lastCall).toBe('/token-usage/stats?sessionId=session-b&fields=chip')
    })
    // Advance time past the old poll's tick — the old session-a interval
    // must have been cleared (no new session-a fetch), the new session-b
    // interval must have fired (one new session-b fetch).
    const beforeAdvance = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeAdvance)
    })
    const sessionACallsAfter = fetchMock.mock.calls
      .filter(call => String(call[0]).includes('sessionId=session-a')).length
    expect(sessionACallsAfter).toBe(sessionACallsBeforeRerender)
  })
})