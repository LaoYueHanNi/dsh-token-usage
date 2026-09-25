// @vitest-environment jsdom
/**
 * Composer-dock usage pill rendering tests: the visibility rules (data
 * present → cost pill, with-subagents badge only for a subtree scope; data
 * absent → nothing renders), the LAZY panel reads (nothing beyond the
 * trigger's totals fetch while closed; opening fires the byModel detail
 * read and the solo-session split read), the panel's explanation of the
 * total (tokens, hit rate, session/subagents split, per-model rows,
 * unpriced footnote), and the falling +Δ fly on cost churn.
 *
 * A fake `fetch` routes on the query shape the host's `/token-usage/stats`
 * route serves: `fields=session` → the byModel detail payload, a multi-id
 * `fields=chip` → the subtree totals, a single-id `fields=chip` → the solo
 * totals.
 *
 * Real timers only — fake timers break jsdom's Response body parsing.
 * Debounce waits use `waitFor` with a timeout past the 250 ms window.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import { CostPill, FETCH_FAILURE_RETRY_MS, type CostPillProps } from '../src/client/CostPill.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageSummary } from '../src/wire.ts'
import { makeUseProjection, useSessionsFromState } from './test-kit.ts'

/** zh-bound translate stub, template-replace semantics to match the real chain. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** The subtree-scoped totals: cost ¥12.34, 1.5M tokens, 80% hit rate. */
const TREE_SUMMARY: UsageSummary = {
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

/** The solo-session totals: cost ¥7.00, 830K tokens (the split's "self" share). */
const SELF_SUMMARY: UsageSummary = {
  ...TREE_SUMMARY,
  total: {
    requests: 6, inputTokens: 60_000, outputTokens: 30_000, cacheReadTokens: 240_000, cacheWriteTokens: 500_000,
  },
  totalCost: 7,
}

/** The panel's detail payload: the subtree totals plus the per-model rows. */
const TREE_DETAIL: UsageSummary = {
  ...TREE_SUMMARY,
  byModel: [
    { model: 'glm-5.3-flash', totals: { requests: 8, inputTokens: 90_000, outputTokens: 40_000, cacheReadTokens: 300_000, cacheWriteTokens: 700_000 } },
    { model: 'deepseek-v4-pro', totals: { requests: 2, inputTokens: 10_000, outputTokens: 10_000, cacheReadTokens: 100_000, cacheWriteTokens: 250_000 } },
  ],
  unpricedModels: ['mini-x'],
}

/** A later subtree summary: cost ¥20 (¥7.66 above the first), more tokens. */
const UPDATED_SUMMARY: UsageSummary = {
  ...TREE_SUMMARY,
  total: {
    requests: 11, inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 950_000,
  },
  totalCost: 20,
}

/** An empty summary: a session with no recorded requests. */
const EMPTY_SUMMARY: UsageSummary = {
  ...TREE_SUMMARY,
  total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  totalCost: 0,
}

/** Live sessionStats for the active session (bumps each request step). */
const LIVE_STATS: SessionStatsProjection = {
  turns: 1, steps: 5, llmMs: 1_000, toolMs: 0, ttftMs: 100, ttftSteps: 2, decodeMs: 500, decodeTokens: 200,
}

/** Build the props the slot renderer binds for the pill. */
function propsOf(
  sessionId: string,
  byId: SessionListState['byId'] = {},
  liveStats: SessionStatsProjection | undefined = LIVE_STATS,
): CostPillProps {
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
  } as CostPillProps
}

/** Solo session row used when the scope holds no subagents. */
const SOLO_BY_ID: SessionListState['byId'] = {
  'session-a': { id: 'session-a', displayTitle: 'Solo', parentId: undefined, blank: false, running: false, updatedAt: 1 },
}

/** A root with one direct subagent. */
const TREE_BY_ID: SessionListState['byId'] = {
  'session-a': { id: 'session-a', displayTitle: 'Parent', parentId: undefined, blank: false, running: false, updatedAt: 1 },
  child: { id: 'child', displayTitle: 'Child', parentId: 'session-a', origin: 'subagent', blank: false, running: false, updatedAt: 2 },
}

/** Stub global fetch with a static payload (or an Error for a failed first load). */
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

/** Stub fetch routed the way the host route serves the pill's three reads:
 * `fields=session` → the byModel detail; a multi-id `chip` → subtree
 * totals; a single-id `chip` → the solo totals. */
function stubFetchRouted(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const ids = url.searchParams.getAll('sessionId')
    const fields = url.searchParams.get('fields') ?? 'full'
    const body = fields === 'session'
      ? TREE_DETAIL
      : ids.length > 1
        ? TREE_SUMMARY
        : SELF_SUMMARY
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Stub fetch with a routed queue for the SUBTREE read only (solo/detail
 * reads keep answering from the last payload); consumed in order. */
function stubTreeSequence(payloads: ReadonlyArray<UsageSummary | Error>): ReturnType<typeof vi.fn> {
  const queue = [...payloads]
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const ids = url.searchParams.getAll('sessionId')
    const fields = url.searchParams.get('fields') ?? 'full'
    if (fields === 'session') return new Response(JSON.stringify(TREE_DETAIL), { status: 200 })
    if (ids.length <= 1) return new Response(JSON.stringify(SELF_SUMMARY), { status: 200 })
    const next = queue.shift() ?? TREE_SUMMARY
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function openPanel(): Promise<void> {
  // The pill renders only after the first fetch settles, so wait for the
  // trigger before clicking it.
  fireEvent.click(await screen.findByRole('button'))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CostPill', () => {
  it('renders nothing before the first fetch lands (empty rule)', () => {
    stubFetch(TREE_SUMMARY)
    const { container } = render(<CostPill {...propsOf('s1')} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the session has zero recorded requests', async () => {
    stubFetch(EMPTY_SUMMARY)
    const { container } = render(<CostPill {...propsOf('s1')} />)
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })

  it('renders the folded cost for a subtree scope (scope naming stays in the aria label)', async () => {
    const fetchMock = stubFetch(TREE_SUMMARY)
    render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    const pill = await screen.findByRole('button')
    expect(pill.textContent).toContain('12.34￥')
    // The visible figure is the amount alone — the scope suffix lives in
    // the accessible name and the open panel, not in the dock row.
    expect(pill.textContent).not.toContain('含子会话')
    expect(pill.getAttribute('aria-label')).toBe('费用（含子会话）12.34￥，点击展开用量明细')
    // The trigger polls the subtree totals read.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/token-usage/stats?sessionId=session-a&sessionId=child&fields=chip',
    )
  })

  it('renders a bare cost for a solo session (official pills share the scope)', async () => {
    stubFetch(TREE_SUMMARY)
    render(<CostPill {...propsOf('session-a', SOLO_BY_ID)} />)
    const pill = await screen.findByRole('button')
    expect(pill.textContent).toContain('12.34￥')
    expect(pill.textContent).not.toContain('含子会话')
    expect(pill.getAttribute('aria-label')).toBe('费用 12.34￥，点击展开用量明细')
  })

  it('fetches nothing beyond the totals read while the panel stays closed', async () => {
    const fetchMock = stubFetchRouted()
    render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    await screen.findByRole('button')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('opens a panel that explains the total: tokens, hit rate, split, per-model, unpriced', async () => {
    stubFetchRouted()
    render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    openPanel()
    const dialog = await screen.findByRole('dialog')
    // Headline total + folded usage (the official pills cannot show these).
    expect(dialog.textContent).toContain('12.34￥')
    expect(dialog.textContent).toContain('1.5M tok')
    expect(dialog.textContent).toContain('缓存命中 80%')
    // The split: self from the solo read, subagents by subtraction.
    expect(dialog.textContent).toContain('本会话')
    expect(dialog.textContent).toContain('7.00￥')
    expect(dialog.textContent).toContain('子会话 ×1')
    expect(dialog.textContent).toContain('5.34￥')
    // Per-model rows + the unpriced footnote.
    expect(dialog.textContent).toContain('glm-5.3-flash')
    expect(dialog.textContent).toContain('× 8')
    expect(dialog.textContent).toContain('deepseek-v4-pro')
    expect(dialog.textContent).toContain('未定价模型 ×1')
    expect(dialog.textContent).toContain('仅计 token')
  })

  it('refetches the panel reads when request churn debounces through while open', async () => {
    const fetchMock = stubTreeSequence([TREE_SUMMARY, UPDATED_SUMMARY])
    const { rerender } = render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    await screen.findByRole('button')
    openPanel()
    await screen.findByRole('dialog')
    const callsWhileOpen = fetchMock.mock.calls.length
    rerender(<CostPill {...propsOf('session-a', TREE_BY_ID, { ...LIVE_STATS, steps: LIVE_STATS.steps + 1 })} />)
    await waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhileOpen) })
  })

  it('closes the panel on outside pointer and Escape', async () => {
    stubFetchRouted()
    render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    openPanel()
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    // Reopen, then an outside pointerdown closes it again.
    openPanel()
    await screen.findByRole('dialog')
    fireEvent.pointerDown(document)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('closes the panel when the session switches', async () => {
    stubFetchRouted()
    const { rerender } = render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    openPanel()
    await screen.findByRole('dialog')
    rerender(<CostPill {...propsOf('session-b', {})} />)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('spawns a falling +Δ fly when a request-driven refresh raises the cost', async () => {
    const fetchMock = stubTreeSequence([TREE_SUMMARY, UPDATED_SUMMARY])
    const { rerender, container } = render(<CostPill {...propsOf('session-a', TREE_BY_ID)} />)
    await screen.findByRole('button')
    rerender(<CostPill {...propsOf('session-a', TREE_BY_ID, { ...LIVE_STATS, steps: LIVE_STATS.steps + 1 })} />)
    await waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2) })
    await waitFor(() => {
      expect(container.querySelector('[class*="deltaFly"]')?.textContent).toBe('+7.66￥')
    }, { timeout: 200 })
    // jsdom ships no WAAPI: the fly mounts but hides itself instead of
    // sitting statically for the whole inflate window.
    const fly = container.querySelector<HTMLElement>('[class*="deltaFly"]')
    expect(fly?.style.visibility).toBe('hidden')
  })

  it('recovers by itself when the first fetch fails', async () => {
    const fetchMock = stubFetchSequence([new Error('startup hiccup'), TREE_SUMMARY])
    const { container } = render(<CostPill {...propsOf('session-a', SOLO_BY_ID)} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    expect(container.firstChild).toBeNull()
    await waitFor(
      () => { expect(fetchMock).toHaveBeenCalledTimes(2) },
      { timeout: FETCH_FAILURE_RETRY_MS + 2_000 },
    )
    expect(await screen.findByRole('button')).not.toBeNull()
  }, 10_000)
})
