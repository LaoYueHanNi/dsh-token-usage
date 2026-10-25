// @vitest-environment jsdom
/**
 * The dashboards' flat row lists: pins the visible contract of the three
 * shapes — the single-line rows (name | relative bar | tokens · cache
 * share | cost), the two-line session rows with their badge and fallback
 * identity (both carried over from the retired session table), the
 * recent-activity sort and the Ctrl affordances (session jump, model
 * filter toggle). The figures cells render plain on every list — a former
 * self-drawn hover popup read as clutter and no list keeps one.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageRows } from '../src/client/UsageRows.tsx'
import type { RowSort } from '../src/client/UsageRows.tsx'
import { formatCost, formatTokens, formatTtft, hitRateDisplay } from '../src/client/format.ts'
import type { CurrencyView } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import type { CostedModelRow, PricingTable, ProjectUsageRow, SessionUsageRow, UsageTotals } from '../src/wire.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Toast: ({ text }: { text: string }) => <div role="alert">{text}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

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

function totals(input: number, output: number, cacheRead = 0, cacheWrite = 0): UsageTotals {
  return { requests: 3, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

const PROJECTS: ProjectUsageRow[] = [
  { name: 'big', cwd: 'D:\\Code\\big', sessionCount: 2, totals: totals(1000, 100, 3000), cost: 12.3 },
  { name: '', cwd: undefined, sessionCount: 1, totals: totals(100, 10, 300), cost: 1.2 },
]

const MODELS: CostedModelRow[] = [
  { model: 'glm-4.7', totals: totals(500, 60, 1500), cost: 3.21 },
  { model: 'mystery-model', totals: totals(50, 5), cost: 0 },
]

const RATES: PricingTable = {
  'glm-4.7': { base: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 }, contextTiers: [], dailySlots: [], timeRules: [] },
}

const NOW = Date.now()

function session(overrides: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    sessionId: 'session-a',
    firstTime: NOW - 3 * 60_000,
    lastTime: NOW - 60_000,
    cost: 0.5,
    totals: totals(10, 2, 40),
    ...overrides,
  }
}

const SESSIONS: SessionUsageRow[] = [
  session({ sessionId: 'aaa-title', title: 'Token 用量页大屏适配', lastTime: NOW - 3 * 3_600_000 }),
  session({ sessionId: 'bbb-fallback', cost: 2.0, lastTime: NOW - 6 * 60_000, childCount: 2, cwd: 'D:\\Code\\deepseek-harness' }),
]

/** A model row carrying performance means (the cost layer's derivation). */
function timedModel(model: string, tokensPerSec: number, firstTokenMs: number, latencyMs: number, samples = 10): CostedModelRow {
  return { model, totals: { ...totals(100, 10), requests: 100 }, cost: 1, perf: { tokensPerSec, firstTokenMs, latencyMs, samples, timedRequests: samples } }
}

/** The dashed jump affordance class on a session/model name button. */
const jumpableClassOf = (name: string): string | null =>
  screen.getByRole('button', { name }).className

describe('UsageRows', () => {
  afterEach(() => { cleanup() })

  it('renders single-line project rows with a relative bar scaled to the tallest row', () => {
    const { container } = render(
      <UsageRows kind="project" projectRows={PROJECTS} costState="ready" view={VIEW} t={t} />,
    )
    const fills = container.querySelectorAll('span[class*="fill"]') as NodeListOf<HTMLElement>
    expect(fills).toHaveLength(2)
    expect(fills[0]!.style.width).toBe('100%')
    expect(fills[1]!.style.width).toBe(`${(410 / 4100) * 100}%`)
    // Figures cell: total tokens · 缓 <hit-rate> — computed by the shared
    // display helpers so the demo's「41.2M · 缓 97.2%」grammar holds.
    const list = screen.getByRole('list', { name: zh['byProject.title'] })
    const big = within(list).getByText('big').closest('div')!
    const hit = hitRateDisplay(PROJECTS[0]!.totals).text
    expect(big.textContent).toContain(`${formatTokens(4100)} · ${zh['stat.cacheRead']} ${hit}`)
    expect(big.textContent).toContain(formatCost(12.3, VIEW))
  })

  it('labels the cwd-less project bucket with the untitled-directory name', () => {
    render(<UsageRows kind="project" projectRows={PROJECTS} costState="ready" view={VIEW} t={t} />)
    expect(screen.getByText(zh['session.untitledDir'])).toBeTruthy()
  })

  it('opens the price dialog from a priced model name and dashes the unpriced one', () => {
    const onModelName = vi.fn()
    render(
      <UsageRows kind="model" modelRows={MODELS} pricing={RATES} costState="ready" view={VIEW} t={t} onModelName={onModelName} />,
    )
    const priced = screen.getByRole('button', { name: zh['pricing.view'].replace('{model}', 'glm-4.7') })
    fireEvent.click(priced)
    expect(onModelName).toHaveBeenCalledWith('glm-4.7')
    // Unpriced: no button (the tag renders instead) and the cost cell dashes.
    expect(screen.queryByRole('button', { name: zh['pricing.view'].replace('{model}', 'mystery-model') })).toBeNull()
    expect(screen.getByText('mystery-model')).toBeTruthy()
    const list = screen.getByRole('list', { name: zh['byModel.title'] })
    const mystery = within(list).getByText('mystery-model').closest('div[class*="row"]')!
    expect(within(mystery).getByText('—')).toBeTruthy()
  })

  it('renders the figures cells plain — no hover tooltip on any list', () => {
    const { container } = render(
      <UsageRows kind="model" modelRows={MODELS} pricing={RATES} costState="ready" view={VIEW} t={t} />,
    )
    // The former four-bucket popup read as clutter, so every list renders
    // the figures cell inert: hovering opens nothing.
    fireEvent.mouseEnter(container.querySelectorAll('span[class*="rowNums"]')[0]!)
    expect(screen.queryByRole('tooltip')).toBeNull()
    const sessions = render(
      <UsageRows kind="session" sessionRows={SESSIONS} costState="ready" view={VIEW} t={t} />,
    )
    fireEvent.mouseEnter(sessions.container.querySelectorAll('span[class*="rowNums"]')[0]!)
    expect(screen.queryByRole('tooltip')).toBeNull()
    cleanup()
    // A non-ready cost layer still dashes the cost cell entirely.
    const projects = render(
      <UsageRows kind="project" projectRows={PROJECTS} costState="pricing-unavailable" view={VIEW} t={t} />,
    )
    expect(within(projects.getByRole('list')).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('renders two-line session rows with badge, fallback identity and the sub line', () => {
    render(
      <UsageRows kind="session" sessionRows={SESSIONS} sort="cost" costState="ready" view={VIEW} t={t} />,
    )
    const list = screen.getByRole('list', { name: zh['bySession.title'] })
    expect(within(list).getByText('Token 用量页大屏适配')).toBeTruthy()
    // Fallback identity: short id + day span (the retired table's rule).
    expect(within(list).getByText(/bbb-fall… · /)).toBeTruthy()
    // The child-count badge rides on the titled row only when present.
    expect(within(list).getByText(zh['view.subagents.nested'].replace('{count}', '2'))).toBeTruthy()
    // Sub line: directory tail · relative activity (the tokens moved up to
    // the figures cell, the same cell grammar the project rows read).
    expect(within(list).getByText(`deepseek-harness · ${zh['time.minutesAgo'].replace('{count}', '6')}`)).toBeTruthy()
    // Figures cell on the top line: total tokens · 缓 <hit-rate>, the same
    // compact cell grammar the project rows render.
    const titledRow = within(list).getByText('Token 用量页大屏适配').closest('div')!.parentElement!
    const hit = hitRateDisplay(SESSIONS[0]!.totals).text
    expect(titledRow.textContent).toContain(`${formatTokens(52)} · ${zh['stat.cacheRead']} ${hit}`)
    // Cost passes through (cost-desc = the served order).
    expect(within(list).getAllByText(formatCost(2.0, VIEW)).length).toBeGreaterThan(0)
  })

  it('re-sorts sessions by last activity under the recent pick', () => {
    const { rerender } = render(
      <UsageRows kind="session" sessionRows={SESSIONS} sort="cost" costState="ready" view={VIEW} t={t} />,
    )
    const orderOf = (): string[] =>
      (screen.getByRole('list', { name: zh['bySession.title'] }).textContent?.match(/Token 用量页大屏适配|bbb-fall…/gu) ?? [])
    // cost = served order straight through.
    expect(orderOf()).toEqual(['Token 用量页大屏适配', 'bbb-fall…'])
    rerender(
      <UsageRows kind="session" sessionRows={SESSIONS} sort={'recent' as RowSort} costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf()).toEqual(['bbb-fall…', 'Token 用量页大屏适配'])
  })

  it('re-sorts every kind under the token and cost picks', () => {
    // Fixtures whose token order and cost order disagree, so each pick is
    // observable: the token crown and the cost crown belong to different
    // rows.
    const projectA: ProjectUsageRow = { name: 'alpha', cwd: 'D:\\Code\\alpha', sessionCount: 1, totals: totals(1000, 0), cost: 1 }
    const projectB: ProjectUsageRow = { name: 'beta', cwd: 'D:\\Code\\beta', sessionCount: 1, totals: totals(500, 0), cost: 9 }
    const modelA: CostedModelRow = { model: 'model-a', totals: totals(1000, 0), cost: 2 }
    const modelB: CostedModelRow = { model: 'model-b', totals: totals(500, 0), cost: 8 }
    const sessionA = session({ sessionId: 'sa', title: '甲会话', totals: totals(100, 0), cost: 0.1, lastTime: NOW - 60_000 })
    const sessionB = session({ sessionId: 'sb', title: '乙会话', totals: totals(50, 0), cost: 5, lastTime: NOW - 3_600_000 })
    const orderOf = (kind: 'project' | 'model' | 'session'): string[] => {
      const label = kind === 'project' ? zh['byProject.title'] : kind === 'model' ? zh['byModel.title'] : zh['bySession.title']
      return (screen.getByRole('list', { name: label }).textContent?.match(/alpha|beta|model-a|model-b|甲会话|乙会话/gu) ?? [])
    }
    // Projects: `tokens` passes the fold's native order through; `cost`
    // re-sorts.
    const projects = render(
      <UsageRows kind="project" projectRows={[projectA, projectB]} sort="tokens" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('project')).toEqual(['alpha', 'beta'])
    // The bars scale in the active sort's own unit: under the tokens pick
    // alpha crowns at 100% and beta bars at half.
    let fills = projects.container.querySelectorAll('span[class*="fill"]')
    expect(fills[0]!.style.width).toBe('100%')
    expect(fills[1]!.style.width).toBe('50%')
    projects.rerender(
      <UsageRows kind="project" projectRows={[projectA, projectB]} sort="cost" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('project')).toEqual(['beta', 'alpha'])
    // Under the cost pick the bars re-scale to cost — beta crowns at 100%,
    // alpha shrinks to its cost share (the bars never contradict the order).
    fills = projects.container.querySelectorAll('span[class*="fill"]')
    expect(fills[0]!.style.width).toBe('100%')
    expect(fills[1]!.style.width).toBe(`${(1 / 9) * 100}%`)
    projects.unmount()
    // Models arrive request-count descending, so both picks re-sort.
    const models = render(
      <UsageRows kind="model" modelRows={[modelA, modelB]} sort="cost" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('model')).toEqual(['model-b', 'model-a'])
    models.rerender(
      <UsageRows kind="model" modelRows={[modelA, modelB]} sort="tokens" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('model')).toEqual(['model-a', 'model-b'])
    models.unmount()
    // Sessions: tokens re-sorts against the served cost order (the fixture
    // arrives cost-descending, which `cost` passes straight through);
    // recent uses the newer lastTime.
    const sessions = render(
      <UsageRows kind="session" sessionRows={[sessionB, sessionA]} sort="tokens" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('session')).toEqual(['甲会话', '乙会话'])
    sessions.rerender(
      <UsageRows kind="session" sessionRows={[sessionB, sessionA]} sort="cost" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('session')).toEqual(['乙会话', '甲会话'])
    sessions.rerender(
      <UsageRows kind="session" sessionRows={[sessionB, sessionA]} sort="recent" costState="ready" view={VIEW} t={t} />,
    )
    expect(orderOf('session')).toEqual(['甲会话', '乙会话'])
  })

  it('renders the performance view as one speed line per model, the cost column dropped', () => {
    const fast = timedModel('fast-model', 177, 1200, 9300)
    const slow = timedModel('slow-model', 53, 3900, 10900)
    const thin = timedModel('thin-model', 52, 1000, 2000, 2)
    const blind: CostedModelRow = { model: 'blind-model', totals: totals(100, 10), cost: 1 }
    const { container } = render(
      <UsageRows kind="model" modelRows={[slow, fast, blind, thin]} pricing={RATES} perfView={true} costState="ready" view={VIEW} t={t} />,
    )
    const list = screen.getByRole('list', { name: zh['byModel.title'] })
    // Speed ranking over the ranked rows; the below-threshold and
    // timing-less rows sink below them, name-ordered among their own
    // group. (nameText, not rowName — the rowName cell also carries tags.)
    const names = [...list.querySelectorAll('span[class*="nameText"], button[class*="nameText"]')].map(el => el.textContent)
    expect(names).toEqual(['fast-model', 'slow-model', 'blind-model', 'thin-model'])
    const text = list.textContent ?? ''
    expect(text).toContain('177 tok/s')
    expect(text).toContain(`${zh['perf.first']} ${formatTtft(1200)}`)
    expect(text).toContain(`${zh['perf.avgLatency']} ${formatTtft(9300)}`)
    // Only timed requests count toward the performance view, even when
    // the model's total request count includes older untimed calls.
    expect(text).toContain(zh['perf.requestCount'].replace('{count}', '10'))
    expect(text).not.toContain(zh['perf.requestCount'].replace('{count}', '100'))
    // Below the sample threshold: speed + 「样本不足」 + count, no means.
    expect(text).toContain(`52 tok/s · ${zh['perf.lowSamples']} · ${zh['perf.requestCount'].replace('{count}', '2')}`)
    expect(text).not.toContain(`${zh['perf.avgLatency']} ${formatTtft(2000)}`)
    // No timing at all renders its own dim label, count included.
    expect(text).toContain(`${zh['perf.noTiming']} · ${zh['perf.requestCount'].replace('{count}', '0')}`)
    // The cost column drops under the perf pick — the row ends at its
    // figures cell.
    expect(container.querySelectorAll('span[class*="rowCost"]')).toHaveLength(0)
    // Only the ranked rows render bars, scaled by mean speed; the dimmed
    // rows drop the track entirely.
    const fills = container.querySelectorAll('span[class*="fill"]') as NodeListOf<HTMLElement>
    expect(fills).toHaveLength(2)
    expect(fills[0]!.style.width).toBe('100%')
    expect(fills[1]!.style.width).toBe(`${(53 / 177) * 100}%`)
  })

  it('opens a listed session only while Ctrl is held', () => {
    const sessionListed = vi.fn(() => true)
    const onSessionOpen = vi.fn()
    render(
      <UsageRows
        kind="session"
        sessionRows={SESSIONS}
        costState="ready"
        view={VIEW}
        t={t}
        sessionListed={sessionListed}
        onSessionOpen={onSessionOpen}
      />,
    )
    const title = screen.getByRole('button', { name: 'Token 用量页大屏适配' })
    // Plain click: inert (no click handler bound while Ctrl is up).
    fireEvent.click(title)
    expect(onSessionOpen).not.toHaveBeenCalled()
    // Ctrl held (the mousemove listener is the truth source while hovering).
    fireEvent(window, new MouseEvent('mousemove', { ctrlKey: true }))
    expect(jumpableClassOf('Token 用量页大屏适配')).toContain('jumpable')
    fireEvent.click(title)
    expect(onSessionOpen).toHaveBeenCalledWith('aaa-title')
    // Releasing Ctrl retires the affordance.
    fireEvent(window, new MouseEvent('mousemove', {}))
    expect(jumpableClassOf('Token 用量页大屏适配')).not.toContain('jumpable')
  })

  it('never invites the session jump for sessions the controller does not list', () => {
    render(
      <UsageRows
        kind="session"
        sessionRows={SESSIONS}
        costState="ready"
        view={VIEW}
        t={t}
        sessionListed={() => false}
        onSessionOpen={vi.fn()}
      />,
    )
    fireEvent(window, new MouseEvent('mousemove', { ctrlKey: true }))
    expect(jumpableClassOf('Token 用量页大屏适配')).not.toContain('jumpable')
  })

  it('toggles the model filter while Ctrl is held, the plain click keeping the price dialog', () => {
    const onToggleModel = vi.fn()
    const onModelName = vi.fn()
    render(
      <UsageRows
        kind="model"
        modelRows={MODELS}
        pricing={RATES}
        costState="ready"
        view={VIEW}
        t={t}
        onToggleModel={onToggleModel}
        onModelName={onModelName}
      />,
    )
    const name = screen.getByRole('button', { name: zh['pricing.view'].replace('{model}', 'glm-4.7') })
    // Plain click still opens the price dialog.
    fireEvent.click(name)
    expect(onModelName).toHaveBeenCalledTimes(1)
    expect(onToggleModel).not.toHaveBeenCalled()
    // Ctrl held: the affordance flips to the filter toggle (label included).
    fireEvent(window, new MouseEvent('mousemove', { ctrlKey: true }))
    const filtered = screen.getByRole('button', { name: zh['model.ctrlHint'] })
    expect(filtered.className).toContain('jumpable')
    fireEvent.click(filtered)
    expect(onToggleModel).toHaveBeenCalledWith('glm-4.7')
    expect(onModelName).toHaveBeenCalledTimes(1)
  })

  it('renders the empty hint when the list has no rows', () => {
    render(<UsageRows kind="project" projectRows={[]} costState="ready" view={VIEW} t={t} />)
    expect(screen.getByText(zh['chart.empty'])).toBeTruthy()
  })
})
