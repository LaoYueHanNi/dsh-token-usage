// @vitest-environment jsdom
/**
 * Usage conversation-view tab tests: renders loading / error / ready over a
 * stubbed fetch, pins the stat cards (4 token buckets, cost, hit rate, TTFT,
 * throughput), the sessionId query parameters for the scope switch and the
 * subagent drill-in, and the empty-session em-dash degradation.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import { UsageView } from '../src/client/UsageView.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageSummary } from '../src/wire.ts'
import {
  makeSessionStateHook, makeUseProjection,
} from './test-kit.ts'

// The shell Tooltip ships inside the primitives package whose CSS imports the
// Node test runtime cannot load (quota-button.client.spec mocks it for the
// same reason). This stand-in keeps the hover contract real: mouseenter shows
// a role="tooltip" bubble with the label, mouseleave hides it.
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

/** Common-namespace zh values the tests assert against (shell-owned copy). */
const COMMON_ZH: Record<string, string> = {
  loading: '加载中…',
  retry: '重试',
  'load.failed': '加载失败',
}

/** zh-bound translate stub, same copy/template behaviour as the real chain. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? COMMON_ZH[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** The active session's summary (distinct values for every assertion). */
const ROOT_SUMMARY: UsageSummary = {
  dataDir: 'C:/data/token-usage',
  currency: 'CNY',
  usdExchangeRate: 7,
  total: {
    requests: 10, inputTokens: 120_000, outputTokens: 8_000, cacheReadTokens: 40_000, cacheWriteTokens: 2_000,
    failures: 2, failuresByCode: { RATE_LIMIT: 1, TRANSPORT: 1 },
  },
  totalCost: 12.34,
  unpricedModels: [],
  pricing: {},
  byDay: [
    { day: '2026-01-15', totals: { requests: 6, inputTokens: 70_000, outputTokens: 5_000, cacheReadTokens: 20_000, cacheWriteTokens: 1_000 } },
    { day: '2026-01-16', totals: { requests: 4, inputTokens: 50_000, outputTokens: 3_000, cacheReadTokens: 20_000, cacheWriteTokens: 1_000 } },
  ],
  byHour: [],
  byModel: [{
    model: 'deepseek-chat',
    totals: { requests: 10, inputTokens: 120_000, outputTokens: 8_000, cacheReadTokens: 40_000, cacheWriteTokens: 2_000,
      failures: 2, failuresByCode: { RATE_LIMIT: 1, TRANSPORT: 1 } },
    cost: 12.34,
  }],
  rateRows: [],
  recent: [],
  children: {
    child: {
      total: { requests: 3, inputTokens: 30_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 500 },
      totalCost: 3.21,
      unpricedModels: [],
    },
  },
}

/** One subagent's own summary. */
const CHILD_SUMMARY: UsageSummary = {
  ...ROOT_SUMMARY,
  total: { requests: 3, inputTokens: 30_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 500 },
  totalCost: 3.21,
  byModel: [{
    model: 'deepseek-reasoner',
    totals: { requests: 3, inputTokens: 30_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 500,
      failures: 0 },
    cost: 3.21,
  }],
}

/** The aggregated parent+child summary served for the tree scope. */
const TREE_SUMMARY: UsageSummary = {
  ...ROOT_SUMMARY,
  total: { requests: 13, inputTokens: 150_000, outputTokens: 10_000, cacheReadTokens: 50_000, cacheWriteTokens: 2_500,
    failures: 2, failuresByCode: { RATE_LIMIT: 1, TRANSPORT: 1 } },
  totalCost: 15.55,
  byModel: [
    {
      model: 'deepseek-chat',
      totals: { requests: 10, inputTokens: 120_000, outputTokens: 8_000, cacheReadTokens: 40_000, cacheWriteTokens: 2_000,
        failures: 2, failuresByCode: { RATE_LIMIT: 1, TRANSPORT: 1 } },
      cost: 12.34,
    },
    {
      model: 'deepseek-reasoner',
      totals: { requests: 3, inputTokens: 30_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 500,
        failures: 0 },
      cost: 3.21,
    },
  ],
  children: {
    child: {
      total: { requests: 3, inputTokens: 30_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 500 },
      totalCost: 3.21,
      unpricedModels: [],
    },
  },
}

/** An empty summary for a session with no records. */
const EMPTY_SUMMARY: UsageSummary = {
  ...ROOT_SUMMARY,
  total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  totalCost: 0,
  byDay: [],
  byHour: [],
  byModel: [],
  rateRows: [],
  recent: [],
}

/** The live session's retained sessionStats (whole-log). */
const LIVE_STATS: SessionStatsProjection = {
  turns: 3, steps: 5, llmMs: 12_000, toolMs: 500, ttftMs: 150, ttftSteps: 3, decodeMs: 8_000, decodeTokens: 2_400,
}

/** The session mirror: a root and one direct subagent. */
const BY_ID: SessionListState['byId'] = {
  root: { id: 'root', displayTitle: 'Root Session', parentId: undefined, blank: false, running: false, updatedAt: 1 },
  child: { id: 'child', displayTitle: 'Child Agent', parentId: 'root', origin: 'subagent', blank: false, running: false, updatedAt: 2 },
}

const SESSION_STATE = {
  ids: ['root', 'child'],
  byId: BY_ID,
  current: 'root',
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
} as SessionListState

/** A mirror where the child owns its own nested subagent. */
const NESTED_BY_ID: SessionListState['byId'] = {
  ...BY_ID,
  grandchild: { id: 'grandchild', displayTitle: 'Deep Agent', parentId: 'child', origin: 'subagent', blank: false, running: false, updatedAt: 3 },
}

/** A fetch stub answering per sessionId query (joined with '+'). */
function stubFetch(overrides: Partial<Record<string, UsageSummary>> = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown): Promise<unknown> => {
    const url = new URL(String(input), 'http://localhost')
    const key = url.searchParams.getAll('sessionId').join('+')
    const body = overrides[key] ?? (key === 'root' ? ROOT_SUMMARY
      : key === 'child' ? CHILD_SUMMARY
        : key === 'root+child' ? TREE_SUMMARY
          : EMPTY_SUMMARY)
    return { ok: true, status: 200, json: async () => body }
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderView(overrides: {
  byId?: SessionListState['byId']
  liveStats?: SessionStatsProjection | undefined
  sessionId?: string
  state?: SessionListState
} = {}): { setMirror: (next: SessionListState) => void } {
  const kit = makeSessionStateHook<SessionListState>(
    overrides.state ?? { ...SESSION_STATE, byId: overrides.byId ?? SESSION_STATE.byId } as SessionListState,
  )
  // Build the props from the kit so the framework-hook types flow through
  // without `as never` casts. The session/view/sessionKit shape is faked
  // by `noSnapshot` so the per-test fakes set up only what the test cares
  // about (the session-list mirror + the live projection).
  render(<UsageView
    useSessions={kit.hook}
    useProjection={makeUseProjection(overrides.liveStats)}
    sessionId={overrides.sessionId ?? 'root'}
    t={t}
  />)
  return { setMirror: kit.setState }
}

/** Whether a stubbed fetch received a call with exactly the given session ids
 * and optional childId groups. */
function sawCall(
  fetch: ReturnType<typeof vi.fn>,
  ids: readonly string[],
  childGroups?: readonly (readonly string[])[],
): boolean {
  return fetch.mock.calls.some((call) => {
    const url = new URL(String(call[0]), 'http://localhost')
    const got = url.searchParams.getAll('sessionId')
    if (!(got.length === ids.length && got.every((value, index) => value === ids[index]))) return false
    if (url.searchParams.get('fields') !== 'session') return false
    if (childGroups === undefined) return true
    const child = url.searchParams.getAll('childId')
    const expected = childGroups.map(group => group.join(','))
    return child.length === expected.length && child.every((value, index) => value === expected[index])
  })
}

/** Assert a text occurs at least once anywhere in the document. */
function expectText(text: string): void {
  expect(screen.getAllByText(text).length).toBeGreaterThan(0)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UsageView', () => {
  it('opts into the host composer overlay so conversation width handles hide', () => {
    stubFetch()
    renderView()
    // ConversationRoot hides [data-width-handle] when a view declares this
    // (Trajectory does the same). Loading / error / ready all share the root.
    expect(document.querySelector('[data-conversation-composer-overlay]')).toBeTruthy()
  })

  it('renders the six stat cards, the token strip, and the model table', async () => {
    const fetch = stubFetch()
    renderView({ liveStats: LIVE_STATS })
    // Cards: successful requests (failure pill), cost, hit rate, TTFT,
    // throughput, total tokens. (The TTFT figure is the first ready-state
    // marker: unique on screen.)
    expect(await screen.findByText('0.1s')).toBeTruthy()
    expectText('10') // successful requests
    expectText('失败 2')
    expect(screen.getAllByText('失败 2')).toHaveLength(1)
    expect(screen.getByRole('columnheader', { name: '成功/失败' })).toBeTruthy()
    expectText('¥12.34') // cost
    // hit rate: 40K cache reads / (120K + 40K) served input = 25%.
    expectText('25%')
    // Same four-bucket colour as the header chip: 25% is `critical`.
    expect(document.querySelector('[class*="band_critical"]')?.textContent).toBe('25%')
    // TTFT 150/3 = 50 ms; throughput 2400 / 8 s = 300 tok/s.
    expectText('0.1s')
    expectText('300 tok/s')
    // 4-token strip + total: 120K + 8K + 40K + 2K (170K total).
    expectText('170K')
    expectText('120K')
    expectText('8K')
    expectText('40K')
    expectText('2K')
    // Model table + chart titles.
    expect(screen.getByText('deepseek-chat')).toBeTruthy()
    expect(screen.getByText('趋势')).toBeTruthy()
    // The scope default fetches only the root session, with the direct child
    // as a childId on the SAME request (no N+1).
    await waitFor(() => expect(sawCall(fetch, ['root'], [['child']])).toBe(true))
    expect(fetch.mock.calls).toHaveLength(1)
    // The subagent table lists the child with its own totals from `children`.
    expect(screen.getByText('Child Agent')).toBeTruthy()
    expectText('3')
    expectText('¥3.21')
  })

  it('switches the scope to the whole subtree with repeated sessionId params', async () => {
    const fetch = stubFetch()
    renderView({ liveStats: LIVE_STATS })
    // Initial scope is session-only; switch to the tree.
    const sessionBtn = await screen.findByRole('button', { name: '本会话' })
    const treeBtn = screen.getByRole('button', { name: '含子会话' })
    expect(sessionBtn.getAttribute('aria-pressed')).toBe('true')
    expect(treeBtn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(treeBtn)
    expect(treeBtn.getAttribute('aria-pressed')).toBe('true')
    expect(sessionBtn.getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(sawCall(fetch, ['root', 'child'], [['child']])).toBe(true))
    // The tree aggregate renders: 13 requests, ¥15.55.
    expectText('13')
    expectText('¥15.55')
    // Per-model cells are `A/B` from that row's totals: the child's
    // reasoner has zero failures, so the cell is just `3` — no `/0`.
    expect(screen.getByText('deepseek-reasoner')).toBeTruthy()
    const modelTable = screen.getByRole('table', { name: '按模型' })
    expect(within(modelTable).getByLabelText('失败 2')).toBeTruthy()
    expect(within(modelTable).queryByText('失败 2')).toBeNull()
    expect(within(modelTable).queryByLabelText('失败 0')).toBeNull()
    const reasonerRow = screen.getByText('deepseek-reasoner').closest('tr')
    expect(reasonerRow?.textContent).not.toContain('/')
  })

  it('drills into a subagent row and offers the back control', async () => {
    const fetch = stubFetch()
    renderView({ liveStats: LIVE_STATS })
    fireEvent.click(await screen.findByRole('button', { name: 'Child Agent' }))
    // The drill-in refetches the child as the focused session (after debounce).
    await waitFor(() => expect(sawCall(fetch, ['child'], [])).toBe(true))
    // The drill-in focus shows a back link to the parent.
    expect(await screen.findByText('← 返回 Root Session')).toBeTruthy()
  })

  it('renders em-dashes when no projection values exist', async () => {
    stubFetch()
    renderView({ liveStats: undefined })
    // Wait for the ready state, then check both TTFT and throughput cards
    // degrade to the unavailable marker.
    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2))
  })

  it('shows the per-code failure breakdown on the failure-pill hover', async () => {
    stubFetch()
    renderView({ liveStats: LIVE_STATS })
    const cardPill = await screen.findByText('失败 2')
    fireEvent.mouseEnter(cardPill)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('限流 ×1\n网络异常 ×1'))
    fireEvent.mouseLeave(cardPill)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    // The per-model cell is `A/B`; hover the red B (row's own totals).
    const table = screen.getByRole('table', { name: '按模型' })
    fireEvent.mouseEnter(within(table).getByLabelText('失败 2'))
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('限流 ×1\n网络异常 ×1'))
    fireEvent.mouseLeave(within(table).getByLabelText('失败 2'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('shows the empty hint for a session with no records', async () => {
    stubFetch({ root: EMPTY_SUMMARY })
    // No subagents at all: drop the child row from the mirror.
    renderView({ byId: { root: SESSION_STATE.byId.root! } })
    expect(await screen.findByText('该会话暂无用量记录。')).toBeTruthy()
    expect(screen.getByText('无子会话')).toBeTruthy()
  })

  it('renders the stat band for a session whose every request failed', async () => {
    // Zero successful requests but two failures: the band still renders
    // (the empty hint only covers a session with no records at all).
    stubFetch({
      root: {
        ...EMPTY_SUMMARY,
        total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, failures: 2 },
      },
    })
    renderView({ byId: { root: SESSION_STATE.byId.root! } })
    expect(await screen.findByText('失败 2')).toBeTruthy()
    expectText('成功请求数')
    expectText('0')
  })

  it('marks a subagent row that owns nested subagents of its own', async () => {
    stubFetch()
    renderView({ byId: NESTED_BY_ID, liveStats: LIVE_STATS })
    await waitFor(() => expectText('¥12.34'))
    // The child row carries its own nested count (1), the other rows none.
    const badge = screen.getByLabelText('含 1 个子会话')
    expect(badge).toBeTruthy()
    expect(badge.textContent).toBe('(1)')
  })

  it('in tree scope, a child row includes nested descendants so totals add up', async () => {
    const childTree = {
      total: { requests: 8, inputTokens: 80_000, outputTokens: 5_000, cacheReadTokens: 20_000, cacheWriteTokens: 1_000 },
      totalCost: 8.88,
      unpricedModels: [] as string[],
    }
    const fetch = stubFetch({
      'root+child+grandchild': {
        ...TREE_SUMMARY,
        total: { requests: 18, inputTokens: 200_000, outputTokens: 15_000, cacheReadTokens: 70_000, cacheWriteTokens: 3_500 },
        totalCost: 21.22,
        children: { child: childTree },
      },
    })
    renderView({ byId: NESTED_BY_ID, liveStats: LIVE_STATS })
    fireEvent.click(await screen.findByRole('button', { name: '含子会话' }))
    await waitFor(() => expect(sawCall(fetch, ['root', 'child', 'grandchild'], [['child', 'grandchild']])).toBe(true))
    expectText('18')
    expectText('¥21.22')
    expectText('¥8.88')
  })

  it('shows the failure and retries the fetch', async () => {
    const fail = vi.fn(async () => {
      throw new Error('boom')
    })
    vi.stubGlobal('fetch', fail)
    renderView({ liveStats: LIVE_STATS })
    expect(await screen.findByText(/加载失败/)).toBeTruthy()
    fail.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ROOT_SUMMARY }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expectText('¥12.34'))
  })

  it('folds the request series into time buckets when the summary carries one', async () => {
    // 55 requests inside ~5.4 s: the whole burst folds into 2 five-second
    // buckets, so the trend keeps bounded granularity (not 55 points).
    const series = Array.from({ length: 55 }, (_, index) => ({
      time: 1_000 + index * 100,
      tokens: 100 + index * 10,
    }))
    const fetch = stubFetch({ root: { ...ROOT_SUMMARY, requestSeries: series } })
    renderView({ liveStats: LIVE_STATS })
    await waitFor(() => expectText('¥12.34'))
    expect(screen.getByLabelText('按时间分段的 token 曲线')).toBeTruthy()
    expect(screen.getAllByLabelText(/请求/).length).toBe(2)
  })

  it('switches the trend chart to cumulative totals', async () => {
    // Same burst fixture: two buckets of 50 and 5 requests (17.25K + 3.1K).
    const series = Array.from({ length: 55 }, (_, index) => ({
      time: 1_000 + index * 100,
      tokens: 100 + index * 10,
    }))
    const fetch = stubFetch({ root: { ...ROOT_SUMMARY, requestSeries: series } })
    renderView({ liveStats: LIVE_STATS })
    // Interval is the default; both mode buttons sit beside the chart title.
    const intervalBtn = await screen.findByRole('button', { name: '分时' })
    const cumulativeBtn = screen.getByRole('button', { name: '累计' })
    expect(intervalBtn.getAttribute('aria-pressed')).toBe('true')
    expect(cumulativeBtn.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('按时间分段的 token 曲线')).toBeTruthy()
    fireEvent.click(cumulativeBtn)
    expect(cumulativeBtn.getAttribute('aria-pressed')).toBe('true')
    expect(intervalBtn.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('累计 token 曲线')).toBeTruthy()
    // Every point's aria now reads a running total: the second bucket's 5
    // requests carry everything before them (17.25K + 3.1K → 20K).
    expect(screen.getAllByLabelText(/累计/).length).toBe(3)
    expect(screen.getByLabelText(/累计 20K/)).toBeTruthy()
    // The mode flip is a pure client-side re-render — no new fetch.
    expect(fetch.mock.calls).toHaveLength(1)
  })

  it('keeps previous figures on screen while a refresh runs (no flash)', async () => {
    let treeCalls = 0
    let resolveSecond: (value: unknown) => void = () => {}
    const fetch = vi.fn(async (input: unknown): Promise<unknown> => {
      const url = new URL(String(input), 'http://localhost')
      const ids = url.searchParams.getAll('sessionId').join('+')
      if (ids === 'root+child') {
        treeCalls += 1
        // The first tree-scope fetch stays pending; the component must keep
        // showing the previously loaded figures while it is in flight.
        if (treeCalls === 1) {
          return await new Promise(resolve => { resolveSecond = resolve })
        }
        return { ok: true, status: 200, json: async () => ({ ...TREE_SUMMARY, totalCost: 99.99 }) }
      }
      return { ok: true, status: 200, json: async () => (ids === 'root' ? ROOT_SUMMARY : CHILD_SUMMARY) }
    })
    vi.stubGlobal('fetch', fetch)
    const { setMirror } = renderView({ liveStats: LIVE_STATS })
    await waitFor(() => expectText('¥12.34'))
    // A request completed: the mirror churns (new byId identity). Switching
    // the scope triggers a render that picks the new mirror up, and the
    // debounced effect refetches at the new scope.
    setMirror({ ...SESSION_STATE, byId: {
      root: { ...SESSION_STATE.byId.root!, updatedAt: SESSION_STATE.byId.root!.updatedAt + 1 },
      child: SESSION_STATE.byId.child!,
    } } as SessionListState)
    fireEvent.click(screen.getByRole('button', { name: '含子会话' }))
    await waitFor(() => expect(treeCalls).toBe(1))
    // While the fetch is pending, the OLD figures stay on screen — no
    // loading flash, no blank.
    expectText('¥12.34')
    expect(screen.queryByText('加载中…')).toBeNull()
    // The response lands: figures update in place.
    resolveSecond({ ok: true, status: 200, json: async () => ({ ...TREE_SUMMARY, totalCost: 99.99 }) })
    await waitFor(() => expectText('¥99.99'))
  })
})