// @vitest-environment jsdom
/**
 * Usage conversation-view tab tests: renders loading / error / ready over a
 * stubbed fetch, pins the stat cards (4 token buckets, cost, hit rate, TTFT,
 * throughput), the sessionId query parameters for the scope switch and the
 * subagent drill-in, and the empty-session em-dash degradation.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import { UsageView } from '../src/client/UsageView.tsx'
import { bandClassOf } from '../src/client/HitRateText.tsx'
import { buildSessionRequestDetails } from '../src/session-request-details.ts'
import { zh } from '../src/client/locales.ts'
import { ASSOCIATIONS_PATH, PRICING_PATH } from '../src/wire.ts'
import type { ConversationStatus, ModelResolution, PricingAssociationsPayload, UsageSummary } from '../src/wire.ts'
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
} = {}): { setMirror: (next: SessionListState) => void; unmount: () => void } {
  const kit = makeSessionStateHook<SessionListState>(
    overrides.state ?? { ...SESSION_STATE, byId: overrides.byId ?? SESSION_STATE.byId } as SessionListState,
  )
  // Build the props from the kit so the framework-hook types flow through
  // without `as never` casts. The session/view/sessionKit shape is faked
  // by `noSnapshot` so the per-test fakes set up only what the test cares
  // about (the session-list mirror + the live projection).
  const view = render(<UsageView
    useSessions={kit.hook}
    useProjection={makeUseProjection(overrides.liveStats)}
    sessionId={overrides.sessionId ?? 'root'}
    t={t}
  />)
  return { setMirror: kit.setState, unmount: view.unmount }
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

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})

describe('UsageView', () => {
  it('associates a missing session model without changing tree scope or child groups', async () => {
    const sourceModel = 'p/internal', targetModelId = 'deepseek-chat'
    let saved = false
    const automatic: ModelResolution = { rawName: sourceModel, status: 'unmatched', candidates: [], strippedPrefix: false }
    const association = { sourceModel, targetModelId, resolvedTargetModelId: targetModelId, state: 'active' as const }
    const associations = (): PricingAssociationsPayload => ({ storageState: 'ready', pricingAvailable: true, writesPaused: false,
      directoryToken: 'directory', revision: saved ? 1 : 0, associations: saved ? [association] : [], resolution: saved
        ? { ...automatic, status: 'matched', modelId: targetModelId, method: 'manual', association, automatic } : automatic })
    const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === ASSOCIATIONS_PATH) {
        if (options?.method === 'POST') saved = true
        return Response.json(associations())
      }
      if (url.pathname === PRICING_PATH) return Response.json({ currency: 'CNY', usdExchangeRate: 7, costState: 'ready', models: [{ modelId: targetModelId, aliasPatterns: [], rules: {
        base: { inputPerMillion: 1, outputPerMillion: 2 }, timeRules: [], contextTiers: [], dailySlots: [],
      } }] })
      const original = url.searchParams.getAll('sessionId').length > 1 ? TREE_SUMMARY : ROOT_SUMMARY
      return Response.json({ ...original, costState: 'ready', modelResolutions: [associations().resolution], unpricedModels: saved ? [] : [sourceModel],
        byModel: [{ ...original.byModel[0]!, model: saved ? targetModelId : sourceModel }] })
    })
    vi.stubGlobal('fetch', fetch)
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: '含子会话' }))
    await waitFor(() => expect(sawCall(fetch, ['root', 'child'], [['child']])).toBe(true))
    const statsCalls = () => fetch.mock.calls.filter(call => String(call[0]).startsWith('/token-usage/stats'))
    const scopedUrl = String(statsCalls().at(-1)![0])
    const table = screen.getByRole('table', { name: '按模型' })
    fireEvent.click(within(table).getByRole('button', { name: t('pricing.unpriced') }))
    fireEvent.click(screen.getByRole('button', { name: t('association.choose') }))
    const dialog = await screen.findByRole('dialog', { name: t('association.title') })
    const search = await within(dialog).findByRole('searchbox')
    fireEvent.change(search, { target: { value: targetModelId } })
    fireEvent.click(within(dialog).getByRole('radio'))
    fireEvent.click(within(dialog).getByRole('button', { name: t('association.save') }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('association.title') })).toBeNull())
    const associationTip = t('association.tooltip', { models: sourceModel })
    await screen.findByRole('img', { name: associationTip })
    expect(String(statsCalls().at(-1)![0])).toBe(scopedUrl)
    expect(screen.getByRole('button', { name: '含子会话' }).getAttribute('aria-pressed')).toBe('true')
    const associationIcon = screen.getByRole('img', { name: associationTip })
    expect(associationIcon.hasAttribute('title')).toBe(false)
    fireEvent.mouseEnter(associationIcon)
    expect(screen.getByRole('tooltip').textContent).toBe(associationTip)
    fireEvent.mouseLeave(associationIcon)
  })
  it('shows association storage failure with retained usage', async () => {
    stubFetch({ root: { ...ROOT_SUMMARY, associationStorageError: 'unreadable' } })
    renderView()
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toBe(t('pricing.associationStorageUnavailable'))
    expect(screen.getByRole('table', { name: t('byModel.title') })).toBeTruthy()
  })
  it.each(['pricing-unavailable', 'history-incomplete'] as const)('retains tokens but hides costs for %s', async costState => {
    stubFetch({ root: { ...ROOT_SUMMARY, costState, totalCost: 9876.54, byModel: ROOT_SUMMARY.byModel.map(row => ({ ...row, cost: 9876.54 })) } })
    renderView()
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toBe(t(costState === 'history-incomplete' ? 'pricing.historyIncomplete' : 'pricing.unavailable'))
    expect(document.body.textContent).not.toContain('9876.54')
    expect(screen.getByRole('table', { name: t('byModel.title') })).toBeTruthy()
  })
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
    // The per-model column header reads 「请求」 (its values still split
    // success/failure); the success/failure wording survives as its title.
    const requestHead = screen.getByRole('columnheader', { name: '请求' })
    expect(requestHead.getAttribute('title')).toBe('成功/失败')
    expectText('12.34￥') // cost
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
    expectText('3.21￥')
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
    expectText('15.55￥')
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
    expectText('请求数')
    expectText('0')
  })

  it('marks a subagent row that owns nested subagents of its own', async () => {
    stubFetch()
    renderView({ byId: NESTED_BY_ID, liveStats: LIVE_STATS })
    await waitFor(() => expectText('12.34￥'))
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
    expectText('21.22￥')
    expectText('8.88￥')
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
    await waitFor(() => expectText('12.34￥'))
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
    await waitFor(() => expectText('12.34￥'))
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
    await waitFor(() => expectText('12.34￥'))
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
    expectText('12.34￥')
    expect(screen.queryByText('加载中…')).toBeNull()
    // The response lands: figures update in place.
    resolveSecond({ ok: true, status: 200, json: async () => ({ ...TREE_SUMMARY, totalCost: 99.99 }) })
    await waitFor(() => expectText('99.99￥'))
  })
})

describe('UsageView request pool', () => {
  /** A completed DeepSeek row with a 9.1% hit: the loss-label shape. */
  const LOSS_ROW = {
    id: 'msg-loss',
    durableRequestId: 'msg-loss',
    sessionId: 'root',
    state: 'completed' as const,
    kind: 'request' as const,
    requestedModel: 'deepseek-chat',
    startedAt: 1_760_000_000_000,
    settledAt: 1_760_000_001_000,
    recordTime: 1_760_000_001_000,
    orderAt: 1_760_000_001_000,
    orderBasis: 'record' as const,
    inputTokens: 1_100,
    outputTokens: 116,
    cacheReadTokens: 110,
    cacheWriteTokens: 0,
    latencyMs: 1_000,
    firstTokenLatencyMs: 300,
    speed: 165,
    cost: 0.01,
    pricingStatus: 'priced' as const,
    cache: { rate: 0.091, eligibility: 'eligible' as const, band: 'loss' as const },
  }
  /** A waiting row from the child subagent. */
  const WAITING_ROW = {
    id: '42:child:t1:s1:a1',
    sessionId: 'child',
    state: 'waiting' as const,
    kind: 'request' as const,
    requestedModel: 'deepseek-chat',
    startedAt: 1_760_000_002_000,
    orderAt: 1_760_000_002_000,
    orderBasis: 'start' as const,
    elapsedMs: 2_400,
    pricingStatus: 'unknown' as const,
    cache: { eligibility: 'unknown' as const, band: 'excluded' as const, reason: 'in-flight' as const },
  }

  function summaryWithRequestDetails(items: readonly unknown[], activeCount = 0, conversation?: ConversationStatus): UsageSummary {
    return {
      ...ROOT_SUMMARY,
      requestDetails: {
        items: items as UsageSummary['requestDetails'] extends undefined ? never[] : NonNullable<UsageSummary['requestDetails']>['items'],
        limit: 20,
        asOf: 1_760_000_004_400,
        activeCount,
        liveCapability: 'lifecycle',
        ...(conversation !== undefined ? { conversation } : {}),
      },
    }
  }

  it('renders the active child above a newer completed parent using the server builder', async () => {
    const pricing = { ready: false, rulesOf: () => undefined, resolve: () => ({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: 0 }) }
    const records = [{ requestId: 'parent-done', sessionId: 'root', time: 5_000, startedAt: 4_000, model: 'parent-model', usage: { inputTokens: 100, outputTokens: 50 } }]
    const rootDetails = buildSessionRequestDetails({ records, live: { attempts: [], activeCount: 0 }, pricing, asOf: 6_000, liveCapability: 'lifecycle' })
    const treeDetails = buildSessionRequestDetails({
      records, pricing, asOf: 6_000, liveCapability: 'lifecycle',
      live: { attempts: [{ id: 'child-live', sessionId: 'child', kind: 'request', state: 'streaming', requestedModel: 'child-model', startedAt: 1_000, turn: 1, step: 1 }], activeCount: 1 },
    })
    stubFetch({ root: { ...ROOT_SUMMARY, requestDetails: rootDetails }, 'root+child': { ...TREE_SUMMARY, requestDetails: treeDetails } })
    renderView()
    await waitFor(() => expect(within(screen.getByRole('region', { name: '最新请求' })).getByText('parent-model')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '含子会话' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: '最新请求' })).getByText('child-model')).toBeTruthy())
    const panel = screen.getByRole('region', { name: '最新请求' })
    expect(within(panel).getByText('生成中')).toBeTruthy()
    expect(within(panel).getByText('子会话')).toBeTruthy()
    const history = screen.getByRole('table', { name: '实时请求' })
    expect(within(history).getByText('parent-model')).toBeTruthy()
    expect(within(history).queryByText('child-model')).toBeNull()
    expect(screen.getAllByText('child-model')).toHaveLength(1)
  })

  it.each([
    [0, 'critical'], [0.4996, 'critical'], [0.5, 'critical'], [0.5999, 'critical'],
    [0.6, 'amber'], [0.7999, 'amber'], [0.8, 'lime'], [0.9499, 'lime'],
    [0.95, 'healthy'], [1, 'healthy'],
  ] as const)('shares the card colour in both request sections at rate %s', async (rate, band) => {
    const row = { ...LOSS_ROW, cache: { ...LOSS_ROW.cache, rate, band: rate < 0.5 ? 'loss' as const : rate < 0.8 ? 'low' as const : 'normal' as const } }
    const summary = summaryWithRequestDetails([row, { ...row, id: 'history' }])
    summary.total = { ...summary.total, inputTokens: 10_000 - Math.round(rate * 10_000), cacheReadTokens: Math.round(rate * 10_000) }
    stubFetch({ root: summary })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const className = bandClassOf(band)
    const card = screen.getByText('命中率', { selector: 'span' }).parentElement!
    expect(card.querySelector('[class*="band_"]')?.className).toBe(className)
    for (const title of ['最新请求', '实时请求']) {
      const section = screen.getByRole('region', { name: title })
      expect(section.querySelector('[class*="band_"]')?.className).toBe(className)
    }
    expect(screen.queryAllByText('缓存过低')).toHaveLength(rate < 0.5 ? 2 : 0)
  })

  it('colours an excluded rate by value but leaves a missing rate neutral', async () => {
    const excluded = { ...LOSS_ROW, cache: { ...LOSS_ROW.cache, rate: 0.4, band: 'excluded' as const, reason: 'cold-start' as const } }
    stubFetch({ root: summaryWithRequestDetails([excluded, WAITING_ROW], 1) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const latest = screen.getByRole('region', { name: '最新请求' })
    expect(within(latest).getByText('40%').className).toBe(bandClassOf('critical'))
    expect(screen.queryByText('缓存过低')).toBeNull()
    const history = screen.getByRole('table', { name: '实时请求' })
    expect(history.querySelector('[class*="band_"]')).toBeNull()
  })

  it('renders the latest panel, the 缓存过低 label glued to the model, and the thirteen history columns', async () => {
    const older = { ...LOSS_ROW, id: 'msg-old', durableRequestId: 'msg-old', state: 'completed' as const, cache: { rate: 0.9, eligibility: 'eligible' as const, band: 'normal' as const } }
    stubFetch({ root: summaryWithRequestDetails([WAITING_ROW, LOSS_ROW, older], 1) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    // The waiting row is the latest: its panel shows the state and the
    // elapsed figure, with no speed fabricated.
    expectText('等待首 token')
    // The lifecycle note rides in the footer's right slot, never on a line
    // of its own: a note that appears and disappears with the request state
    // would change the panel's height and push the history table around.
    const latest = screen.getByRole('region', { name: '最新请求' })
    const footer = latest.querySelector('[class*="requestFooter"]')!
    expect(footer.textContent).toContain('首 token 尚未到达')
    expect(latest.querySelector('[class*="requestNote"]')).toBeTruthy()
    expectText('已耗时')
    expect(screen.getByTitle('已耗时（按服务端时间锚定）')).toBeTruthy()
    // The pool count includes the latest item itself.
    expectText('请求池 3 / 20')
    // The history table renders the frozen column order.
    const table = screen.getByRole('table', { name: '实时请求' })
    const head = Array.from(table.querySelectorAll('th')).map(cell => cell.textContent)
    expect(head).toEqual(['来源', '状态', '时间', '模型', '缓存命中', '输入', '输出', '缓存读', '缓存写', '首字', '耗时', '速度', '费用'])
    // The loss row's label sits inside the model cell's inline group.
    const lossRow = table.querySelector('tbody tr')!
    expect(lossRow.textContent).toContain('缓存过低')
    expect(lossRow.textContent).toContain('9.1%')
    expectText('本会话')
  })

  it('states where the conversation stands in the footer slot and keeps the request’s own diagnostic in the tooltip', async () => {
    // A settled request whose cache assessment was excluded: the diagnostic
    // explains the request, the conversation state explains the dialogue.
    const coldStart = { ...LOSS_ROW, cache: { eligibility: 'unknown' as const, band: 'excluded' as const, reason: 'cold-start' as const } }
    stubFetch({ root: summaryWithRequestDetails([coldStart], 0, { state: 'turn-complete' }) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const latest = screen.getByRole('region', { name: '最新请求' })
    const footer = latest.querySelector('[class*="requestFooter"]')!
    expect(footer.textContent).toContain('本轮对话已完成')
    expect(footer.textContent).not.toContain('冷启动')
    // The diagnostic is not dropped: it rides in the note's tooltip.
    fireEvent.mouseEnter(latest.querySelector('[class*="requestNote"]')!)
    const tooltip = screen.getByRole('tooltip').textContent!
    expect(tooltip).toContain('本轮对话已完成')
    expect(tooltip).toContain('冷启动')
  })

  it('says the conversation is waiting for the tool result', async () => {
    stubFetch({ root: summaryWithRequestDetails([LOSS_ROW], 0, { state: 'awaiting-tool' }) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const footer = screen.getByRole('region', { name: '最新请求' }).querySelector('[class*="requestFooter"]')!
    expect(footer.textContent).toContain('等待tool结果')
  })

  it('says the conversation is retrying after a failure, with the attempt count', async () => {
    const failed = { ...LOSS_ROW, state: 'failed' as const, failureCode: 'RATE_LIMIT', speed: undefined }
    stubFetch({
      root: summaryWithRequestDetails([failed], 0, {
        state: 'retrying',
        retry: { count: 2, max: 5, delayMs: 3_000, code: 'RATE_LIMIT' },
      }),
    })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const latest = screen.getByRole('region', { name: '最新请求' })
    const footer = latest.querySelector('[class*="requestFooter"]')!
    expect(footer.textContent).toContain('请求失败，正在重试（2/5）')
    // The failure code and the backoff wait stay readable in the tooltip.
    fireEvent.mouseEnter(latest.querySelector('[class*="requestNote"]')!)
    const tooltip = screen.getByRole('tooltip').textContent!
    expect(tooltip).toContain('RATE_LIMIT')
    expect(tooltip).toContain('3 秒后重试')
  })

  it('lets the conversation state outrank the request’s own note, and keeps the latter in the tooltip', async () => {
    stubFetch({ root: summaryWithRequestDetails([WAITING_ROW], 1, { state: 'turn-complete' }) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const latest = screen.getByRole('region', { name: '最新请求' })
    const footer = latest.querySelector('[class*="requestFooter"]')!
    expect(footer.textContent).toContain('本轮对话已完成')
    expect(footer.textContent).not.toContain('首 token 尚未到达')
    // The request's own note is not lost — it rides in the tooltip.
    fireEvent.mouseEnter(latest.querySelector('[class*="requestNote"]')!)
    expect(screen.getByRole('tooltip').textContent).toContain('首 token 尚未到达')
  })

  it('shows the request’s own lifecycle note when the conversation has no conclusion', async () => {
    stubFetch({ root: summaryWithRequestDetails([WAITING_ROW], 1) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const footer = screen.getByRole('region', { name: '最新请求' }).querySelector('[class*="requestFooter"]')!
    expect(footer.textContent).toContain('首 token 尚未到达')
  })

  it('hides the cache-write column when no visible request reports a write bucket', async () => {
    const withoutWrites = [
      { ...LOSS_ROW, cacheWriteTokens: undefined },
      { ...LOSS_ROW, id: 'history-no-write', cacheWriteTokens: undefined },
    ]
    stubFetch({ root: summaryWithRequestDetails(withoutWrites) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const table = screen.getByRole('table', { name: '实时请求' })
    expect(Array.from(table.querySelectorAll('th')).map(cell => cell.textContent)).toEqual([
      '来源', '状态', '时间', '模型', '缓存命中', '输入', '输出', '缓存读', '首字', '耗时', '速度', '费用',
    ])
    expect(screen.queryByText('缓存写')).toBeNull()
  })

  it('shows the canonical pricing model id in the latest panel', async () => {
    const row = { ...LOSS_ROW, requestedModel: 'group/glm-5.3-flashx', modelId: 'glm-5.3-flashx' }
    stubFetch({ root: summaryWithRequestDetails([row]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    expect(within(screen.getByRole('region', { name: '最新请求' })).getByText('glm-5.3-flashx')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '最新请求' })).queryByText('group/glm-5.3-flashx')).toBeNull()
  })

  it('keeps the 50% label boundary independent of the numeric colour scale', async () => {
    const boundary = {
      ...LOSS_ROW,
      id: 'msg-half',
      durableRequestId: 'msg-half',
      inputTokens: 12_000,
      cacheReadTokens: 12_000,
      cache: { rate: 0.5, eligibility: 'eligible' as const, band: 'low' as const },
    }
    stubFetch({ root: summaryWithRequestDetails([boundary]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    expect(screen.queryByText('缓存过低')).toBeNull() // Exactly 50%: no label, shared critical colour.
    expectText('50%')
    expectText('还没有上一条请求 · 下一条到来后，当前请求会移入这里')
  })

  it('marks a session-attributed title request and never adds the cache-low tag', async () => {
    const title = {
      ...LOSS_ROW,
      id: 'aux-title',
      kind: 'aux' as const,
      auxKind: 'session-title' as const,
      requestedModel: 'title-model',
      cache: { rate: 0, eligibility: 'eligible' as const, band: 'excluded' as const, reason: 'auxiliary' as const },
    }
    stubFetch({ root: summaryWithRequestDetails([title]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    // A single request is shown only in the latest panel; it moves into the
    // history table once a newer request arrives.
    expect(screen.getAllByText('标题')).toHaveLength(1)
    expect(screen.queryByText('缓存过低')).toBeNull()
  })

  it('does not add a tooltip just to explain an ordinary low-band colour', async () => {
    const row = { ...LOSS_ROW, cache: { ...LOSS_ROW.cache, rate: 0.694, band: 'low' as const } }
    stubFetch({ root: summaryWithRequestDetails([row]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    fireEvent.mouseEnter(screen.getByText('69.4%'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it.each([0.397, 0.4996])('omits threshold and exclusion boilerplate from the cache-loss tooltip at %s', async rate => {
    stubFetch({ root: summaryWithRequestDetails([{ ...LOSS_ROW, cache: { ...LOSS_ROW.cache, rate } }]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    fireEvent.mouseEnter(screen.getByText('缓存过低'))
    const tooltip = screen.getByRole('tooltip').textContent!
    expect(tooltip).toContain('本次缓存命中')
    expect(tooltip).toContain('不代表已确认服务端缓存失效')
    expect(tooltip).not.toContain('低于 50%')
    expect(tooltip).not.toContain('已排除')
    if (rate === 0.4996) expect(tooltip).toContain('原始命中率为')
  })

  it('renders an empty pool as 0 / 20 with the empty prompt, even for a zero-request session', async () => {
    stubFetch({ root: { ...EMPTY_SUMMARY, requestDetails: { items: [], limit: 20, asOf: 1_760_000_000_000, activeCount: 0, liveCapability: 'settled-only' } } })
    renderView()
    await waitFor(() => expectText('该会话暂无用量记录。'))
    expectText('请求池 0 / 20')
    expectText('暂无请求 · 发起第一条请求后，速度与缓存信息将在这里展示')
  })

  it('maps origins to the drill-in focus: child rows read 子会话 under the root focus', async () => {
    const childDone = { ...LOSS_ROW, id: 'c1', durableRequestId: 'c1', sessionId: 'child', cache: { rate: 0.9, eligibility: 'eligible' as const, band: 'normal' as const } }
    stubFetch({ root: summaryWithRequestDetails([LOSS_ROW, childDone]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    const table = screen.getByRole('table', { name: '实时请求' })
    expect(table.querySelector('tbody tr')!.textContent).toContain('子会话')
  })

  it('stamps the stale notice while a refresh fails but the snapshot survives', async () => {
    let fail = false
    const mock = vi.fn(async (input: unknown): Promise<unknown> => {
      const url = new URL(String(input), 'http://localhost')
      if (fail) throw new Error('boom')
      void url
      return { ok: true, status: 200, json: async () => summaryWithRequestDetails([LOSS_ROW]) }
    })
    vi.stubGlobal('fetch', mock)
    renderView()
    await waitFor(() => expectText('最新请求'))
    fail = true
    renderView()
    await waitFor(() => expect(mock.mock.calls.length).toBeGreaterThan(1))
    // The previous snapshot is still on screen (silentAfterFirst) — the
    // stale notice renders on the NEXT successful render cycle's failure.
    expectText('9.1%')
  })

  it('serializes the fallback poll: a slow response is never cancelled by the next tick', async () => {
    // The reviewer's repro: a 1.5s response under a 1s interval used to be
    // cancelled by every new poll — the page never updated. The serialized
    // poll schedules the next tick only after the last fetch settles.
    let completed = 0
    let abortedMidFlight = 0
    const mock = vi.fn(async (input: unknown, options?: RequestInit): Promise<unknown> => {
      void input
      await new Promise(resolve => setTimeout(resolve, 1_500))
      if ((options?.signal as AbortSignal | undefined)?.aborted) {
        abortedMidFlight += 1
        throw new Error('superseded')
      }
      completed += 1
      return { ok: true, status: 200, json: async () => summaryWithRequestDetails([{ ...LOSS_ROW, id: `row-${String(completed)}` }]) }
    })
    vi.stubGlobal('fetch', mock)
    renderView()
    await waitFor(() => expectText('最新请求'), { timeout: 5_000 })
    expect(completed).toBe(1)
    // Idle cadence: the next poll waits 5s after the settle — no per-second
    // refetch storm while the previous answer is still in flight.
    await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(mock.mock.calls.length).toBe(1)
    // The second poll runs, completes, and nothing was cancelled mid-flight.
    await waitFor(() => expect(completed).toBe(2), { timeout: 8_000 })
    expect(abortedMidFlight).toBe(0)
  }, 20_000)

  it('stops polling entirely after unmount', async () => {
    const mock = vi.fn(async (): Promise<unknown> => ({
      ok: true, status: 200, json: async () => summaryWithRequestDetails([LOSS_ROW]),
    }))
    vi.stubGlobal('fetch', mock)
    const { unmount } = renderView()
    await waitFor(() => expectText('最新请求'))
    unmount()
    const calls = mock.mock.calls.length
    // Past one full idle interval: no late tick may fire a fetch.
    await new Promise(resolve => setTimeout(resolve, 5_600))
    expect(mock.mock.calls.length).toBe(calls)
  }, 15_000)

  it('lands a new scope’s first failure in error instead of showing the previous scope’s snapshot', async () => {
    let failTree = false
    const mock = vi.fn(async (input: unknown): Promise<unknown> => {
      const ids = new URL(String(input), 'http://localhost').searchParams.getAll('sessionId')
      if (ids.length > 1) {
        if (failTree) throw new Error('tree fetch failed')
        return { ok: true, status: 200, json: async () => TREE_SUMMARY }
      }
      return { ok: true, status: 200, json: async () => ROOT_SUMMARY }
    })
    vi.stubGlobal('fetch', mock)
    renderView()
    await waitFor(() => expectText('12.34￥'))
    failTree = true
    fireEvent.click(screen.getByRole('button', { name: '含子会话' }))
    // The scope switch's own fetch fails: the root figures (12.34￥) must
    // not stay on screen as if they described the tree scope.
    await waitFor(() => expect(screen.getByText(/统计加载失败/)).toBeTruthy(), { timeout: 5_000 })
    expect(screen.queryByText('15.55￥')).toBeNull()
  }, 15_000)

  it('never fetches the previous range under a new scope when visibility refreshes during the debounce window', async () => {
    const requested: string[] = []
    const mock = vi.fn(async (input: unknown): Promise<unknown> => {
      const ids = new URL(String(input), 'http://localhost').searchParams.getAll('sessionId').join('+')
      requested.push(ids)
      if (ids === 'root+child') throw new Error('new scope unavailable')
      return { ok: true, status: 200, json: async () => ROOT_SUMMARY }
    })
    vi.stubGlobal('fetch', mock)
    renderView()
    await waitFor(() => expectText('12.34￥'))
    const priorCalls = requested.length
    fireEvent.click(screen.getByRole('button', { name: '含子会话' }))
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(screen.getByText(/统计加载失败/)).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(requested.slice(priorCalls).every(ids => ids === 'root+child')).toBe(true)
    expect(screen.getByText(/统计加载失败/)).toBeTruthy()
  })

  it('does not promise future speed settlement for an already completed untimed row', async () => {
    stubFetch({ root: summaryWithRequestDetails([{ ...LOSS_ROW, speed: undefined, firstTokenLatencyMs: undefined }]) })
    renderView()
    await waitFor(() => expectText('最新请求'))
    expect(screen.queryByText('待结束后结算')).toBeNull()
    expect(screen.queryByText('请求已结算')).toBeNull()
    expectText('已完成')
    expectText('历史记录无完整计时 · 不以 0 或会话平均值代替')
  })

  it('drops a previous scope’s late response after the scope has switched', async () => {
    let resolveRoot: (value: unknown) => void = () => {}
    const mock = vi.fn(async (input: unknown): Promise<unknown> => {
      const ids = new URL(String(input), 'http://localhost').searchParams.getAll('sessionId')
      if (ids.length > 1) return { ok: true, status: 200, json: async () => TREE_SUMMARY }
      return await new Promise((resolve) => { resolveRoot = resolve })
    })
    vi.stubGlobal('fetch', mock)
    renderView()
    await waitFor(() => expect(mock.mock.calls.length).toBe(1)) // the root fetch hangs
    fireEvent.click(screen.getByRole('button', { name: '含子会话' }))
    await waitFor(() => expectText('15.55￥'), { timeout: 5_000 })
    // The hung root response lands late: already aborted by the scope
    // switch, it must not repaint the tree view with root figures (the
    // reasoner row and the 15.55￥ total only exist in the tree scope).
    resolveRoot({ ok: true, status: 200, json: async () => ROOT_SUMMARY })
    await new Promise(resolve => setTimeout(resolve, 100))
    expectText('15.55￥')
    expect(screen.getByText('deepseek-reasoner')).toBeTruthy()
  }, 15_000)
})
