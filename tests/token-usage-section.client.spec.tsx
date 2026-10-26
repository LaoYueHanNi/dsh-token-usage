// @vitest-environment jsdom
/**
 * Token-usage settings page component tests: renders the loading, error, and
 * ready states over a stubbed fetch, exercises the filter bar (the range
 * date picker popover, model select, quick range buttons), pins the overview
 * board's cards and the detail tabs' row lists (by project default, by
 * model, by session, runtime overhead), pins the token-abbreviation and
 * cache-hit-rate formatting, and covers the per-model pricing dialog (open
 * from a model row, full rule-chain rows).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatHitRate, formatTokens, TokenUsageSection, totalTokens } from '../src/client/TokenUsageSection.tsx'
import { zh } from '../src/client/locales.ts'
import { ASSOCIATIONS_PATH, PRICING_PATH } from '../src/wire.ts'
import type { PricingOverviewPayload, PricingAssociationsPayload, ModelResolution, UsageSummary } from '../src/wire.ts'

// The shell Tooltip ships inside the primitives package whose CSS imports the
// Node test runtime cannot load (quota-button.client.spec mocks it for the
// same reason). This stand-in keeps the hover contract real: mouseenter shows
// a role="tooltip" bubble with the label, mouseleave hides it.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { cloneElement, useState } = await import('react')
  return {
    Toast: ({ text, onDone }: { text: string; onDone?: () => void }) => (
      <div role="alert" onClick={onDone}>{text}</div>
    ),
    IconWarningOutlineRegular: () => <span data-testid="icon-warning" />,
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

/**
 * zh-bound translate stub: renders the same copy the tests were written on,
 * with `{name}` template substitution like the real lookup chain.
 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? COMMON_ZH[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}) as TranslateNS<'token-usage'>

/** A fully populated summary fixture (reasoner priced at ¥4/¥16/¥1 per million). */
const SUMMARY: UsageSummary = {
  costState: 'ready',
  modelResolutions: [],
  dataDir: 'C:/data/token-usage',
  currency: 'CNY',
  usdExchangeRate: 7,
  total: {
    requests: 4,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    failures: 1,
    failuresByCode: { RATE_LIMIT: 1 },
  },
  totalCost: 0.0014,
  unpricedModels: [],
  pricing: {
    'deepseek-reasoner': {
      base: { inputPerMillion: 4, outputPerMillion: 16, cacheReadPerMillion: 1 },
      contextTiers: [],
      dailySlots: [],
      timeRules: [],
    },
  },
  byDay: [
    { day: '2026-01-15', totals: { requests: 2, inputTokens: 20, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1 } },
    { day: '2026-01-16', totals: { requests: 2, inputTokens: 10, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 1 } },
  ],
  byHour: [],
  byModel: [{
    // Values distinct from the totals cards so table assertions are unambiguous.
    model: 'deepseek-reasoner',
    totals: {
      requests: 1,
      inputTokens: 100,
      outputTokens: 60,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      failures: 1,
      failuresByCode: { RATE_LIMIT: 1 },
    },
    cost: 0.0014,
  }],
  rateRows: [
    { day: '2026-01-15', model: 'deepseek-chat', rate: { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }, totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { day: '2026-01-16', model: 'deepseek-reasoner', rate: { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }, totals: { requests: 1, inputTokens: 100, outputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 } },
  ],
  recent: [],
}

function stubFetch(impl: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

/** A pricing-overview fixture: two families (deepseek < glm), the used
 * model in the first one. */
const OVERVIEW: PricingOverviewPayload = {
  models: [
    { modelId: 'deepseek-reasoner', aliasPatterns: ['^deepseek-think$'], family: 'deepseek', rules: SUMMARY.pricing['deepseek-reasoner']! },
    { modelId: 'glm-4.7', aliasPatterns: [], family: 'glm', rules: SUMMARY.pricing['deepseek-reasoner']! },
  ],
  currency: 'CNY',
  usdExchangeRate: 7,
}

// jsdom ships no dialog methods; stub the pair showModal/close so the
// pricing dialog behaves like a browser (close fires the `close` event
// the component's onClose listens for).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('formatTokens', () => {
  it('keeps raw counts below 1K', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses K below 1M', () => {
    expect(formatTokens(1_234)).toBe('1.2K')
    expect(formatTokens(12_345)).toBe('12K')
    expect(formatTokens(950_000)).toBe('950K')
    expect(formatTokens(999_999)).toBe('1000K') // boundary: still K tier
  })

  it('uses M from 1M up to 10 亿, never fractional B', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(9_600_000)).toBe('9.6M')
    expect(formatTokens(12_000_000)).toBe('12M')
    expect(formatTokens(100_000_000)).toBe('100M') // 1 亿 stays M
    expect(formatTokens(150_000_000)).toBe('150M')
    expect(formatTokens(950_000_000)).toBe('950M')
    expect(formatTokens(999_999_999)).toBe('1000M') // boundary: still M tier
  })

  it('uses B only from 10 亿 (1e9) up', () => {
    expect(formatTokens(1_000_000_000)).toBe('1B')
    expect(formatTokens(1_500_000_000)).toBe('1.5B')
    expect(formatTokens(3_000_000_000)).toBe('3B')
    expect(formatTokens(10_000_000_000)).toBe('10B')
  })
})

describe('totalTokens / formatHitRate', () => {
  it('sums the four buckets', () => {
    expect(totalTokens({ requests: 1, inputTokens: 30, outputTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 2 }))
      .toBe(47)
  })

  it('renders the cache hit rate with one decimal and a dash for nothing served', () => {
    expect(formatHitRate({ requests: 1, inputTokens: 30, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 }))
      .toBe('9.1%')
    expect(formatHitRate({ requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }))
      .toBe('100%')
    expect(formatHitRate({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
      .toBe('—')
  })
})

/** Wait for the ready branch (the by-project fold is the default tab),
 * then switch to the by-model tab and return its row list. */
async function openModelTab(): Promise<HTMLElement> {
  await screen.findByRole('list', { name: t('byProject.title') })
  fireEvent.click(screen.getByRole('button', { name: t('byModel.title') }))
  return screen.getByRole('list', { name: t('byModel.title') })
}

describe('TokenUsageSection', () => {
  it('groups the settings tabs and compact controls in one toolbar above the page-style usage lists', async () => {
    stubFetch(async () => Response.json({
      ...SUMMARY,
      projectRows: [{ name: 'proj-a', cwd: '/work/proj-a', sessionCount: 2, totals: SUMMARY.total, cost: 0.0014 }],
    }))
    render(<TokenUsageSection t={t} />)
    const projects = await screen.findByRole('list', { name: t('byProject.title') })
    const tabs = screen.getByRole('group', { name: t('detail.switch.label') })
    const sort = screen.getByRole('group', { name: t('byProject.title') })
    expect(tabs.parentElement).toBe(sort.closest('[class*="detailToolbar"]'))
    // All three data tabs render the page's bar-column layout (no compact
    // class anywhere; projects/models carry the relative bar).
    expect(projects.className).not.toContain('rowsCompact')
    expect(projects.querySelector('[class*="track"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('byModel.title') }))
    const models = screen.getByRole('list', { name: t('byModel.title') })
    expect(models.className).not.toContain('rowsCompact')
    expect(models.querySelector('[class*="track"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('perf.toggle') }))
    expect(screen.getByRole('button', { name: t('perf.toggle') }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('group', { name: t('byModel.title') }).parentElement?.className).toContain('sortHidden')
    fireEvent.click(screen.getByRole('button', { name: t('bySession.title') }))
    const sessions = screen.getByRole('list', { name: t('bySession.title') })
    expect(sessions.className).not.toContain('rowsCompact')
  })

  it.each(['panel', 'page'] as const)('uses authoritative project rows instead of folding the truncated sessions (%s)', async variant => {
    stubFetch(async () => Response.json({
      ...SUMMARY,
      sessionRows: [{ sessionId: 's', cwd: '/work/partial', totals: SUMMARY.total, cost: 1, firstTime: 0, lastTime: 0 }],
      projectRows: [{ name: 'complete-project', cwd: '/work/complete-project', sessionCount: 1001, totals: SUMMARY.total, cost: 9 }],
    }))
    render(<TokenUsageSection t={t} variant={variant} />)
    const projects = await screen.findByRole('list', { name: t('byProject.title') })
    expect(within(projects).getByText('complete-project')).toBeTruthy()
    expect(within(projects).queryByText('partial')).toBeNull()
  })

  it('offers the runtime-overhead dimension in the detail switch and renders its empty hint', async () => {
    stubFetch(async () => Response.json(SUMMARY))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findByRole('list', { name: t('byProject.title') })
    fireEvent.click(screen.getByRole('button', { name: t('aux.tab') }))
    expect(await screen.findByText(t('aux.empty'))).toBeTruthy()
    // The dimension switch swaps the rows, never the page.
    expect(screen.queryByRole('list', { name: t('byProject.title') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('byModel.title') }))
    expect(screen.getByRole('list', { name: t('byModel.title') })).toBeTruthy()
  })

  it('renders the auxiliary breakdown when the summary carries runtime overhead', async () => {
    const kindTotals = { requests: 2, inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const aux = {
      total: kindTotals,
      cost: 0.02,
      byKind: [{
        auxKind: 'auto-review' as const,
        totals: kindTotals,
        cost: 0.02,
        byModel: [{ model: 'deepseek-flash', totals: kindTotals, cost: 0.02 }],
      }],
    }
    stubFetch(async () => Response.json({ ...SUMMARY, aux }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findByRole('list', { name: t('byProject.title') })
    // The aux layer also lights the composite card's overhead pill.
    fireEvent.click(screen.getByRole('button', { name: t('stat.overheadPill', { count: '2' }) }))
    const list = await screen.findByRole('list', { name: t('aux.tab') })
    // Expanded by default (the user's pick): the per-model line shows
    // beneath its kind row.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('自动审查')).toBeTruthy()
    expect(within(list).getByText('deepseek-flash')).toBeTruthy()
    // Folding the kind's disclosure hides its per-model line.
    fireEvent.click(within(list).getByRole('button', { name: '自动审查' }))
    expect(within(list).queryByText('deepseek-flash')).toBeNull()
    // The total line sits beneath the list.
    expect(screen.getByText(t('aux.totalCount', { count: '2' }))).toBeTruthy()
  })

  it('saves from an unpriced row, retains filters, marks origins and updates overview usage', async () => {
    const rawName = 'p/unknown', targetModelId = 'deepseek-reasoner'
    let saved = false
    const unresolved: ModelResolution = { rawName, status: 'unmatched', strippedPrefix: false, candidates: [] }
    const association = { sourceModel: rawName, targetModelId, resolvedTargetModelId: targetModelId, state: 'active' as const }
    const snapshot = (): PricingAssociationsPayload => ({ directoryToken: 'directory', revision: saved ? 1 : 0,
      storageState: 'ready', pricingAvailable: true, writesPaused: false, associations: saved ? [association] : [],
      resolution: saved ? { ...unresolved, status: 'matched', method: 'manual', modelId: targetModelId, association, automatic: unresolved } : unresolved })
    const fetch = stubFetch(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === ASSOCIATIONS_PATH) {
        if (options?.method === 'POST') { saved = true }
        return Response.json(snapshot())
      }
      if (url.pathname === PRICING_PATH) return Response.json(OVERVIEW)
      return Response.json({ ...SUMMARY, totalCost: saved ? 7 : 0, unpricedModels: saved ? [] : [rawName], modelResolutions: [snapshot().resolution],
        byModel: [{ ...SUMMARY.byModel[0]!, model: saved ? targetModelId : rawName, cost: saved ? 7 : 0 }] })
    })
    render(<TokenUsageSection close={() => {}} t={t} />)
    const list = await openModelTab()
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '7d' }))
    // The tab pick survives the refetch (session-local state).
    await screen.findByRole('list', { name: t('byModel.title') })
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('option', { name: rawName }))
    const modelList = await screen.findByRole('list', { name: t('byModel.title') })
    const beforeQueries = fetch.mock.calls.filter(call => String(call[0]).startsWith('/token-usage/stats'))
    const filterUrl = String(beforeQueries.at(-1)![0])
    expect(within(modelList).queryByRole('button', { name: t('association.choose') })).toBeNull()
    fireEvent.click(within(modelList).getByRole('button', { name: t('pricing.unpriced') }))
    fireEvent.click(screen.getByRole('button', { name: t('association.choose') }))
    const dialog = await screen.findByRole('dialog', { name: t('association.title') })
    const search = await within(dialog).findByRole('searchbox')
    fireEvent.change(search, { target: { value: targetModelId } })
    fireEvent.click(within(dialog).getByRole('radio'))
    fireEvent.click(within(dialog).getByRole('button', { name: t('association.save') }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('association.title') })).toBeNull())
    const associationTip = t('association.tooltip', { models: rawName })
    await screen.findByRole('img', { name: associationTip })
    const afterQueries = fetch.mock.calls.filter(call => String(call[0]).startsWith('/token-usage/stats'))
    expect(String(afterQueries.at(-1)![0])).toBe(filterUrl)
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('7d')
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe(rawName)
    const nextList = screen.getByRole('list', { name: t('byModel.title') })
    expect(within(nextList).getByText('7.00￥')).toBeTruthy()
    const associationIcon = within(nextList).getByRole('img', { name: associationTip })
    expect(associationIcon.hasAttribute('title')).toBe(false)
    fireEvent.mouseEnter(associationIcon)
    expect(screen.getByRole('tooltip').textContent).toBe(associationTip)
    fireEvent.mouseLeave(associationIcon)
    expect(within(nextList).queryByText('含手动关联')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '定价表' }))
    const overview = await screen.findByRole('dialog', { name: '定价表' })
    await within(overview).findByText(targetModelId)
    expect(within(overview).getByText('已用').closest('tr')?.textContent).toContain(targetModelId)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  })
  it('keeps all-association management available for an empty filtered window', async () => {
    stubFetch(async () => Response.json({ ...SUMMARY, total: { ...SUMMARY.total, requests: 0, failures: 0 }, byModel: [] }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findByText(t('empty'))
    expect(screen.queryByRole('button', { name: t('association.manage') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '定价表' }))
    const overview = screen.getByRole('dialog', { name: '定价表' })
    expect(within(overview).getByRole('button', { name: t('association.manage') })).toBeTruthy()
  })
  it('places management beside the pricing title and retains both dialogs across revocation refresh', async () => {
    let saved = true
    const fetch = stubFetch(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === PRICING_PATH) return Response.json(OVERVIEW)
      if (url.pathname === ASSOCIATIONS_PATH) {
        if (options?.method === 'DELETE') saved = false
        return Response.json({ directoryToken: 'directory', revision: saved ? 1 : 2, storageState: 'ready', pricingAvailable: true,
          writesPaused: false, associations: saved ? [{ sourceModel: 'p/internal', targetModelId: 'deepseek-chat', state: 'active' }] : [] })
      }
      return Response.json(SUMMARY)
    })
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findByRole('list', { name: '按项目' })
    expect(screen.queryByRole('button', { name: '模型别名关联' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '定价表' }))
    const overview = screen.getByRole('dialog', { name: '定价表' })
    const managerButton = within(overview).getByRole('button', { name: '模型别名关联' })
    expect(managerButton.parentElement?.textContent).toBe('定价表模型别名关联')
    managerButton.focus(); fireEvent.click(managerButton)
    const manager = screen.getByRole('dialog', { name: '模型别名关联' })
    expect(overview.contains(manager)).toBe(true)
    fireEvent.click(await within(manager).findByRole('button', { name: t('association.revoke') }))
    fireEvent.click(within(manager).getByRole('button', { name: t('association.confirmRevoke') }))
    await within(manager).findByText(t('association.revoked'))
    await waitFor(() => expect(fetch.mock.calls.filter(call => String(call[0]).startsWith('/token-usage/stats')).length).toBeGreaterThan(1))
    await screen.findByRole('list', { name: '按项目' })
    expect(screen.getByRole('dialog', { name: '定价表' })).toBe(overview)
    expect(screen.getByRole('dialog', { name: '模型别名关联' })).toBe(manager)
    fireEvent.click(within(manager).getByRole('button', { name: t('association.close') }))
    expect(screen.queryByRole('dialog', { name: '模型别名关联' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '定价表' })).toBe(overview)
    expect(document.activeElement).toBe(managerButton)
  })
  it('reports corrupted association storage while leaving automatic costs visible', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ...SUMMARY, associationStorageError: 'invalid-json' }) }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toBe(t('pricing.associationStorageUnavailable'))
    expect(document.body.textContent).toContain('￥')
    expect(screen.queryByRole('button', { name: t('association.manage') })).toBeNull()
  })
  it.each(['pricing-unavailable', 'history-incomplete'] as const)('hides every cost but retains model usage when %s', async costState => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ...SUMMARY, costState, totalCost: 9876.54, byModel: SUMMARY.byModel.map(row => ({ ...row, cost: 9876.54 })) }) }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toBe(t(costState === 'history-incomplete' ? 'pricing.historyIncomplete' : 'pricing.unavailable'))
    expect(document.body.textContent).not.toContain('9876.54')
    // The model tab still lists the rows (their cost cells dash).
    fireEvent.click(screen.getByRole('button', { name: t('byModel.title') }))
    expect(screen.getByRole('list', { name: t('byModel.title') })).toBeTruthy()
    expect(screen.getByText('deepseek-reasoner')).toBeTruthy()
    expect(document.body.textContent).not.toContain('9876.54')
  })
  it('hides identification details and row actions until the unpriced tag is clicked', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ...SUMMARY, modelResolutions: [
      { rawName: 'p/unknown', status: 'unmatched', strippedPrefix: false, candidates: [] },
      { rawName: 'collision', status: 'ambiguous', strippedPrefix: true, candidates: ['one', 'two'] },
    ], pricing: {}, unpricedModels: ['p/unknown', 'collision'], byModel: [
      { ...SUMMARY.byModel[0]!, model: 'p/unknown' }, { ...SUMMARY.byModel[0]!, model: 'collision' },
    ] }) }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    const list = await openModelTab()
    expect(screen.queryByText(t('pricing.identificationDetails'))).toBeNull()
    expect(screen.queryByRole('button', { name: t('association.choose') })).toBeNull()
    expect(screen.queryByRole('link', { name: t('association.issue') })).toBeNull()
    // The unpriced tag rides beside its model's name; the rows re-sort by
    // token size (a tie folds to the name), so address the row by its
    // model, not by index.
    const collisionRow = within(list).getByText('collision').closest('div')!
    fireEvent.click(within(collisionRow).getByRole('button', { name: '未定价' }))
    const dialog = screen.getByRole('dialog', { name: t('association.unpricedTitle') })
    expect(within(dialog).getByText('collision')).toBeTruthy()
    expect(within(dialog).getByText(/one, two/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: t('association.choose') })).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: t('association.issue') })).toBeTruthy()
  })
  it('shows loading, then the overview board and the default by-project rows', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(screen.getByText('加载中…')).toBeTruthy()
    // '总 token' heads exactly one card now (the board's).
    expect(await screen.findAllByText('总 token')).toHaveLength(1)
    // Board cards: the composite lead (请求数, failure + overhead
    // pills), cost / total tokens (47) / hit rate (9.1%), and the four
    // buckets — the panel's compact two-rows-of-four layout.
    expect(screen.getByText('请求数')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('失败 1')).toBeTruthy()
    expect(screen.getAllByText('0.00￥').length).toBeGreaterThan(0)
    expect(screen.getByText('47')).toBeTruthy()
    expect(screen.getByText('9.1%')).toBeTruthy()
    // Same four-bucket colour as the header chip: 9.1% is `critical`.
    expect(document.querySelector('[class*="band_critical"]')?.textContent).toBe('9.1%')
    expect(screen.getAllByText('入').length).toBeGreaterThan(0)
    // '30' matches the card value and possibly a y-axis tick; at least the card is there.
    expect(screen.getAllByText('30').length).toBeGreaterThan(0)
    expect(screen.getAllByText('出').length).toBeGreaterThan(0)
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getAllByText('缓').length).toBeGreaterThan(0)
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getAllByText('写').length).toBeGreaterThan(0)
    expect(screen.getByText('2')).toBeTruthy()
    // The trend card: titled 趋势, the 1d window plotting the day's 24
    // hours with no plot pick (the hourly/daily segmented is gone).
    expect(screen.getByText('趋势')).toBeTruthy()
    expect(screen.getByRole('img', { name: '单日分时 token 曲线' })).toBeTruthy()
    // The detail switch defaults to 按项目. The fixture carries no session
    // rows, so the fold renders its empty hint; the switch is the only
    // "按项目" label (no separate heading).
    expect(screen.getAllByText('按项目').length).toBe(1)
    expect(screen.getByText('区间内暂无数据')).toBeTruthy()
    // Switching to the model tab lists the model row: its own figures and
    // the pricing affordance (no dialog until clicked).
    const list = await openModelTab()
    expect(within(list).getByText('deepseek-reasoner')).toBeTruthy()
    // The figures cell: total (200) · 缓 28.6% — the same hit rate the old
    // table column carried.
    const nums = within(list).getByText(/200 · 缓 28\.6%/)
    // The figures cell carries no hover tooltip on the model list (the
    // popup is a session-list affordance only).
    fireEvent.mouseEnter(nums)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(within(list).getByRole('button', { name: '查看 deepseek-reasoner 定价' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    // No per-day / recent sections.
    expect(screen.queryByText('最近请求')).toBeNull()
  })

  it('shows the per-code failure breakdown on the failure-pill hover', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    const cardPill = await screen.findByText('失败 1')
    fireEvent.mouseEnter(cardPill)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('限流 ×1'))
    fireEvent.mouseLeave(cardPill)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('renders the page variant as the four-card dashboard without a dimension switch', async () => {
    const kindTotals = { requests: 2, inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const aux = {
      total: kindTotals,
      cost: 0.02,
      byKind: [{ auxKind: 'auto-review' as const, totals: kindTotals, cost: 0.02, byModel: [] }],
    }
    const sessionRows = [
      { sessionId: 's1', title: 'Token 用量页大屏适配', firstTime: 0, lastTime: Date.now() - 60_000, cost: 4.18, totals: kindTotals, cwd: 'D:\\Code\\dsh-token-usage' },
      { sessionId: 's2', firstTime: 0, lastTime: Date.now() - 180_000, cost: 2.11, totals: kindTotals, cwd: 'D:\\Code\\deepseek-harness', childCount: 2 },
    ]
    const fetchMock = stubFetch(async () => Response.json({ ...SUMMARY, aux, sessionRows }))
    render(<TokenUsageSection close={() => {}} t={t} variant="page" />)
    // All four cards render their lists at once — no dimension switch.
    await screen.findByRole('list', { name: '按项目' })
    expect(screen.queryByRole('group', { name: t('detail.switch.label') })).toBeNull()
    expect(screen.getByRole('list', { name: '按会话' })).toBeTruthy()
    expect(screen.getByRole('list', { name: '按模型' })).toBeTruthy()
    expect(screen.getByRole('list', { name: '运行开销' })).toBeTruthy()
    // Card heads: the counts ride beside the titles (two directory tails
    // fold into two projects; one model row); every card head carries a
    // sort — sessions default to cost (its 费用 pick pressed), projects
    // and models to tokens, so address the sessions card's own control.
    expect(screen.getByText('2 个 · 按总 token')).toBeTruthy()
    expect(screen.getByText('1 个 · 按总 token')).toBeTruthy()
    expect(screen.getByText('共 2 条')).toBeTruthy()
    expect(screen.getByText('辅助模型请求')).toBeTruthy()
    const sessionCard = screen.getByText('共 2 条').closest('div')!.parentElement!
    expect(within(sessionCard).getByRole('button', { name: '费用' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(screen.getByRole('group', { name: t('board.projects') })).getByRole('button', { name: '费用' }))
    fireEvent.click(within(screen.getByRole('group', { name: t('board.models') })).getByRole('button', { name: '费用' }))
    expect(screen.getByText('2 个 · 按费用')).toBeTruthy()
    expect(screen.getByText('1 个 · 按费用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('perf.toggle') }))
    expect(screen.getByText('1 个 · 按输出速度')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('perf.toggle') }))
    expect(screen.getByText('1 个 · 按费用')).toBeTruthy()
    expect(screen.getByText('Token 用量页大屏适配')).toBeTruthy()
    // The composite card's overhead pill scrolls to (and flashes) the
    // overhead card. jsdom ships no scrollIntoView; record the calls and
    // delete the stub afterwards.
    const scrollCalls: Element[] = []
    HTMLElement.prototype.scrollIntoView = function (this: Element): void { scrollCalls.push(this) }
    try {
      const pill = screen.getByRole('button', { name: t('stat.overheadPill', { count: '2' }) })
      fireEvent.click(pill)
      expect(scrollCalls.length).toBeGreaterThan(0)
      expect(document.querySelector('[class*="flash"]')).toBeTruthy()
    } finally {
      // Delete rather than assign undefined: an undefined own property
      // would still shadow the prototype chain below HTMLElement.
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView
    }
    // Ctrl+click on a model row toggles the model filter (a single pick):
    // the affordance flips to the Ctrl hint, and the next stats fetch
    // carries the model parameter.
    fireEvent(window, new MouseEvent('mousemove', { ctrlKey: true }))
    fireEvent.click(screen.getByRole('button', { name: t('model.ctrlHint') }))
    await waitFor(() => {
      const last = fetchMock.mock.calls.filter(call => String(call[0]).startsWith('/token-usage/stats')).at(-1)
      expect(String(last?.[0])).toContain('model=deepseek-reasoner')
    })
  })

  it('shows the empty hint when nothing matches', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        total: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byModel: [],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(await screen.findByText(/暂无数据/)).toBeTruthy()
    // No model rows without a selection, so no pricing affordance either
    // (the filter row's pricing-table link is an action, not an affordance).
    expect(screen.queryByRole('button', { name: '定价' })).toBeNull()
  })

  it('marks unpriced rows and dashes their cost without a summary warning', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        totalCost: 0.0014,
        unpricedModels: ['deepseek-reasoner'],
        pricing: {},
        byModel: [{ ...SUMMARY.byModel[0]!, cost: 0 }],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    const list = await openModelTab()
    expect(screen.queryByText(/个模型未定价：/)).toBeNull()
    expect(within(list).getByText('未定价')).toBeTruthy()
    // Unpriced cost cells render an em dash, not a fake ¥0.00, and the
    // row retains the unpriced action.
    expect(within(list).getByText('—')).toBeTruthy()
    expect(within(list).getByRole('button', { name: '未定价' })).toBeTruthy()
  })

  it('renders costs and rates in USD under an overseas summary', async () => {
    // large enough to be visible at $ scale: ¥7.00 ÷ 7 = $1.00.
    const usdSummary: UsageSummary = {
      ...SUMMARY,
      currency: 'USD',
      usdExchangeRate: 7,
      totalCost: 7,
      byModel: [{ ...SUMMARY.byModel[0]!, cost: 7 }],
    }
    stubFetch(async () => ({ ok: true, json: async () => usdSummary }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    // The cost card and the model row's cost cell both read $1.00.
    expect(await screen.findAllByText('总 token')).toHaveLength(1)
    await openModelTab()
    expect(screen.getAllByText('1.00$').length).toBeGreaterThan(0)

    // The pricing dialog converts every rate: ¥4/¥16 → $0.5714/$2.2857,
    // cache read ¥1 → $0.1429, cache write falls back to input $0.5714.
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const dialog = await screen.findByRole('dialog')
    const table = within(dialog).getByRole('table')
    expect(within(table).getByText('默认').closest('tr')!.textContent).toBe('默认$0.5714$2.2857$0.1429$0.5714')
    // The conversion note names the rate.
    expect(within(dialog).getByText('按 1 USD = 7 CNY 换算')).toBeTruthy()
    // Close the dialog to leave a clean tree.
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps USD totals and unpriced row tags without a summary warning', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        currency: 'USD',
        usdExchangeRate: 7,
        totalCost: 7,
        unpricedModels: ['deepseek-reasoner'],
        pricing: {},
        byModel: [{ ...SUMMARY.byModel[0]!, cost: 0 }],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    const list = await openModelTab()
    expect(screen.queryByText(/个模型未定价：/)).toBeNull()
    expect(screen.getByText('1.00$')).toBeTruthy()
    expect(within(list).getByRole('button', { name: '未定价' })).toBeTruthy()
    expect(within(list).getByText('—')).toBeTruthy()
  })

  it('shows the failure and retries the fetch', async () => {
    const fetch = stubFetch(async () => {
      throw new Error('network down')
    })
    render(<TokenUsageSection close={() => {}} t={t} />)
    expect(await screen.findByText(/统计加载失败：network down/)).toBeTruthy()

    fetch.mockResolvedValueOnce({ ok: true, json: async () => SUMMARY })
    fireEvent.click(screen.getByText('重试'))
    expect(await screen.findAllByText('总 token')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('opens the pricing overview from the filter row tail link, filter-free', async () => {
    const urls: string[] = []
    stubFetch(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      return { ok: true, json: async () => (url.startsWith('/token-usage/pricing') ? OVERVIEW : SUMMARY) }
    })
    render(<TokenUsageSection close={() => {}} t={t} />)
    // The tail link sits in the filter row; opening the overview fetches
    // the pricing route with no filter parameters at all.
    fireEvent.click(await screen.findByRole('button', { name: '定价表' }))
    const dialog = await screen.findByRole('dialog', { name: '定价表' })
    expect((dialog as HTMLDialogElement).open).toBe(true)
    // A flat family-sorted list: both models' rows visible (no folding),
    // the page's used model tagged.
    expect(within(dialog).getByText('deepseek-reasoner')).toBeTruthy()
    expect(within(dialog).getByText('已用')).toBeTruthy()
    expect(within(dialog).getByText('glm-4.7')).toBeTruthy()
    // Exactly one overview fetch, carrying no query string.
    const pricingCalls = urls.filter(url => url.startsWith('/token-usage/pricing'))
    expect(pricingCalls).toEqual(['/token-usage/pricing'])
  })
})

describe('TokenUsageSection filtering', () => {
  /** Local `YYYY-MM-DD` of today shifted by whole days. */
  function dayKey(offsetDays: number): string {
    const date = new Date()
    date.setDate(date.getDate() + offsetDays)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }

  it('renders no refresh button once ready', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    expect(screen.queryByText('刷新')).toBeNull()
  })

  it('mirrors the shell root color-scheme and follows theme switches', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // The shell projects the active scheme onto documentElement.style only;
    // the section mirrors it so its form controls render natively dark.
    // (MutationObserver delivers asynchronously, hence the awaits.)
    document.documentElement.style.colorScheme = 'dark'
    await new Promise(resolve => setTimeout(resolve, 0))
    const root = screen.getByText('Token 用量').closest('div')
    expect(root?.style.colorScheme).toBe('dark')
    // A theme switch rewrites the root inline style; the mirror follows.
    document.documentElement.style.colorScheme = 'light'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root?.style.colorScheme).toBe('light')
    document.documentElement.style.removeProperty('color-scheme')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root?.style.colorScheme).toBe('')
  })

  it('renders the filter bar: quick range menu, date range trigger, model menu', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const quick = screen.getByRole('button', { name: '快捷区间' })
    expect(quick.textContent).toBe('1d')
    fireEvent.click(quick)
    for (const label of ['1d', '7d', '30d', '全部日期', '自定义']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: '日期范围' })).toBeTruthy()
    const model = screen.getByRole('button', { name: '模型' })
    expect(model.textContent).toBe('全部模型')
    fireEvent.click(model)
    expect(screen.getByRole('option', { name: '全部模型' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'deepseek-reasoner' })).toBeTruthy()
  })

  it('defaults to the 1d window: triggers reflect today', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const url = new URL(String(fetch.mock.calls[0]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(0))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
    expect(screen.getByRole('button', { name: '日期范围' }).textContent).toBe(`${dayKey(0)} 至 ${dayKey(0)}`)
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('1d')
  })

  it('fetches the 7d window (today minus 6 through today) when 7d is chosen', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '7d' }))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(-6))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
    // Back in the ready state, the trigger reflects the active window.
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('7d')
  })

  it('fetches unconstrained when ALL is chosen from the quick menu', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '全部日期' }))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBeNull()
    expect(url.searchParams.get('to')).toBeNull()
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('全部日期')
  })

  it('fetches with the model parameter when a model is chosen', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-reasoner' }))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('model')).toBe('deepseek-reasoner')
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('deepseek-reasoner')
  })

  it('marks the quick range custom once the popover settles a non-quick range', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText('上个月'))
    // The previous month's first day clicked twice: a single-day custom range
    // that never equals a quick range (those end on today).
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('自定义')
  })

  it('sorts the range when the second click lands earlier than the first', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // Click today first (the LATER end), then the previous month's first day:
    // the committed range still arrives sorted.
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(dayKey(0)))
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(prevMonthFirstDay())
    expect(url.searchParams.get('to')).toBe(dayKey(0))
  })

  it('opens a pricing dialog from the model row: each billing condition on its own row', async () => {
    // 2026-01-01 / 2026-02-01 at 12:00 UTC: the same local date in every
    // realistic timezone, so the window text is stable on any runner.
    const RULE_START = 1_767_268_800
    const RULE_END = 1_769_947_200
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        pricing: {
          'glm-5.2': {
            base: { inputPerMillion: 2, outputPerMillion: 8 },
            contextTiers: [{ threshold: 512000, rates: { inputPerMillion: 6, outputPerMillion: 24 }, dailySlots: [{ windows: [{ startMinute: 600, endMinute: 660 }], daysOfWeek: [6, 7], rates: { inputPerMillion: 6.5, outputPerMillion: 26 } }] }],
            dailySlots: [{
              label: '峰时',
              windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
              daysOfWeek: [1, 2, 3, 4, 5],
              rates: { inputPerMillion: 4, outputPerMillion: 16 },
            }],
            timeRules: [{
              label: '原价',
              startTime: RULE_START,
              endTime: RULE_END,
              rates: { inputPerMillion: 1, outputPerMillion: 2 },
              contextTiers: [{ threshold: 128000, rates: { inputPerMillion: 3, outputPerMillion: 6 } }],
              dailySlots: [{
                label: '峰时',
                windows: [{ startMinute: 600, endMinute: 660 }],
                daysOfWeek: [1, 3],
                rates: { inputPerMillion: 1.5, outputPerMillion: 3 },
              }],
            }],
          },
          'deepseek-reasoner': SUMMARY.pricing['deepseek-reasoner']!,
          // Priced, but absent from the filter selection: no affordance.
          'unused-model': SUMMARY.pricing['deepseek-reasoner']!,
        },
        byModel: [
          { model: 'glm-5.2', totals: { requests: 5, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0.5 },
          ...SUMMARY.byModel,
        ],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await openModelTab()

    // The unused priced model never surfaces an affordance.
    expect(screen.queryByRole('button', { name: /unused-model/ })).toBeNull()

    // Open the rule-carrier's dialog from its row.
    fireEvent.click(screen.getByRole('button', { name: '查看 glm-5.2 定价' }))
    const dialog = await screen.findByRole('dialog')
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(within(dialog).getByText('glm-5.2')).toBeTruthy()
    const glmTable = within(dialog).getByRole('table')

    // The rule-carrier: condition column first, four rate columns after.
    expect(within(glmTable).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['计费条件', '入/M', '出/M', '缓/M', '写/M'])
    // The regular group (outside the rule window) opens the table…
    expect(within(glmTable).getByText('常规（规则期外）')).toBeTruthy()
    // …default rates (cache falls back to the input rate), then the context
    // tier, then the root peak slot with both of its windows. Slots carrying
    // `daysOfWeek` render by label + windows only — the weekday restriction
    // stays out of the condition text.
    expect(within(glmTable).getAllByText('默认')[0]!.closest('tr')!.textContent).toBe('默认￥2￥8￥2￥2')
    expect(within(glmTable).getByText('上下文 ≥512K').closest('tr')!.textContent).toBe('上下文 ≥512K￥6￥24￥6￥6')
    expect(within(glmTable).getByText('峰时 09:00-12:00、14:00-18:00').closest('tr')!.textContent)
      .toBe('峰时 09:00-12:00、14:00-18:00￥4￥16￥4￥4')
    // …then the time rule gets its own group with its date window, an
    // isolated default, its own tier, and its own peak slot.
    expect(within(glmTable).getByText('原价 2026-01-01 ~ 2026-02-01')).toBeTruthy()
    expect(within(glmTable).getAllByText('默认')).toHaveLength(2)
    expect(within(glmTable).getAllByText('默认')[1]!.closest('tr')!.textContent).toBe('默认￥1￥2￥1￥1')
    expect(within(glmTable).getByText('上下文 ≥128K').closest('tr')!.textContent).toBe('上下文 ≥128K￥3￥6￥3￥3')
    expect(within(glmTable).getByText('上下文 ≥512K · 峰时 10:00-11:00').closest('tr')!.textContent)
      .toBe('上下文 ≥512K · 峰时 10:00-11:00￥6.50￥26￥6.50￥6.50')
    expect(within(glmTable).getByText('峰时 10:00-11:00').closest('tr')!.textContent).toBe('峰时 10:00-11:00￥1.50￥3￥1.50￥1.50')

    // The close button dismisses the dialog.
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // The flat model: one default row, explicit cache read rate, cache
    // write falling back to the input rate, no group divider.
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const flatDialog = await screen.findByRole('dialog')
    const flatTable = within(flatDialog).getByRole('table')
    expect(within(flatTable).queryByText('常规（规则期外）')).toBeNull()
    expect(within(flatTable).getByText('默认').closest('tr')!.textContent).toBe('默认￥4￥16￥1￥4')
  })

  it('drops the bogus 1970 start of a since-forever time rule', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        pricing: {
          'deepseek-reasoner': {
            base: { inputPerMillion: 2, outputPerMillion: 8 },
            contextTiers: [],
            dailySlots: [],
            timeRules: [{ label: '原价', startTime: 0, endTime: 1_786_881_600, rates: { inputPerMillion: 1, outputPerMillion: 2 } }],
          },
        },
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await openModelTab()
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const dialog = await screen.findByRole('dialog')
    // “~ <end>”, not “1970-01-01 ~ <end>”.
    expect(within(dialog).getByText('原价 ~ 2026-08-16')).toBeTruthy()
  })

  it('orders the rule groups newest era first, regardless of feed order', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        pricing: {
          'deepseek-reasoner': {
            base: { inputPerMillion: 2, outputPerMillion: 8 },
            contextTiers: [],
            dailySlots: [],
            // 12:00 UTC bounds: the same local date on every runner. The feed
            // lists the oldest era first, as the real feed does.
            timeRules: [
              { label: '原价', startTime: 0, endTime: Date.UTC(2026, 3, 25, 12) / 1000, rates: { inputPerMillion: 4, outputPerMillion: 16 } },
              { label: '长期降价', startTime: Date.UTC(2026, 3, 25, 12) / 1000, endTime: Date.UTC(2026, 7, 16, 12) / 1000, rates: { inputPerMillion: 2, outputPerMillion: 8 } },
            ],
          },
        },
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await openModelTab()
    fireEvent.click(screen.getByRole('button', { name: '查看 deepseek-reasoner 定价' }))
    const dialog = await screen.findByRole('dialog')
    const table = within(dialog).getByRole('table')
    // Group headers top-to-bottom: the model root (current era) first, then
    // the rule eras newest first (larger end higher).
    const groups = [...table.querySelectorAll('td[colspan="5"]')].map(cell => cell.textContent)
    expect(groups).toEqual(['常规（规则期外）', '长期降价 2026-04-25 ~ 2026-08-16', '原价 ~ 2026-04-25'])
  })

  it('renders the daily token chart from the day rows', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // The fixture's days are in the past; clear the default 1d window so the
    // chart spans the fixture rows (the real server filters byDay instead).
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByText('清除范围'))
    await screen.findAllByText('总 token')
    const chart = await screen.findByRole('img', { name: '每日总 token 曲线' })
    // Day totals are 31 and 16, so the y axis tops out at a round 40 (ticks 10..40).
    for (const tick of ['10', '20', '30', '40']) {
      expect(within(chart).getByText(tick)).toBeTruthy()
    }
    // Day labels (MM-DD) close the x axis.
    expect(within(chart).getByText('01-15')).toBeTruthy()
    expect(within(chart).getByText('01-16')).toBeTruthy()
  })

  it('floats a day label when a chart point is hovered or focused', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByText('清除范围'))
    await screen.findAllByText('总 token')
    const chart = await screen.findByRole('img', { name: '每日总 token 曲线' })

    // No label before any interaction.
    expect(within(chart).queryByText(/总量/)).toBeNull()

    // Hovering a day's hit zone floats its date + total (day 2 totals 16).
    fireEvent.mouseEnter(within(chart).getByLabelText('2026-01-16 总量 16'))
    expect(within(chart).getByText('2026-01-16 总量 16')).toBeTruthy()
    // Hovering the other day swaps the label (day 1 totals 31).
    fireEvent.mouseEnter(within(chart).getByLabelText('2026-01-15 总量 31'))
    expect(within(chart).getByText('2026-01-15 总量 31')).toBeTruthy()

    // Keyboard focus works the same way; leaving the chart clears the label.
    fireEvent.focus(within(chart).getByLabelText('2026-01-16 总量 16'))
    expect(within(chart).getByText('2026-01-16 总量 16')).toBeTruthy()
    fireEvent.mouseLeave(chart)
    expect(within(chart).queryByText(/总量/)).toBeNull()
  })

  it('renders the 1d window as the day\'s 24-hour trend, folding models per hour', async () => {
    // Hourly rows on today (the default 1d window): 1K at 09:00, 3K at 14:00.
    const today = dayKey(0)
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        ...SUMMARY,
        byHour: [
          { hour: `${today}T09`, model: 'deepseek-chat', totals: { requests: 1, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          { hour: `${today}T09`, model: 'deepseek-reasoner', totals: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          { hour: `${today}T14`, model: 'deepseek-chat', totals: { requests: 1, inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        ],
      }),
    }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const chart = await screen.findByRole('img', { name: '单日分时 token 曲线' })
    // The full 00:00-23:00 sequence: 24 plotted hours, future ones at zero.
    expect(within(chart).getAllByLabelText(/总量/)).toHaveLength(24)
    // Hourly totals 1K and 3K, so the y axis tops out at a round 3K.
    for (const tick of ['1K', '2K', '3K']) {
      expect(within(chart).getByText(tick)).toBeTruthy()
    }
    // Clock labels (HH:00) close the x axis at first/middle/last.
    expect(within(chart).getByText('00:00')).toBeTruthy()
    expect(within(chart).getByText('11:00')).toBeTruthy()
    expect(within(chart).getByText('23:00')).toBeTruthy()
    // Hovering an hour floats its date + clock time; both models fold into 09:00.
    fireEvent.mouseEnter(within(chart).getByLabelText(`${today} 09:00 总量 1K`))
    expect(within(chart).getByText(`${today} 09:00 总量 1K`)).toBeTruthy()
  })

  it('switches back to the daily chart once the range spans more than one day', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // The default 1d window renders the hourly chart.
    expect(await screen.findByRole('img', { name: '单日分时 token 曲线' })).toBeTruthy()
    // A wider range falls back to the daily granularity.
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.click(screen.getByRole('option', { name: '7d' }))
    await waitForCall(fetch, 2)
    expect(await screen.findByRole('img', { name: '每日总 token 曲线' })).toBeTruthy()
  })
})

/** Local `YYYY-MM-DD` of today. */
function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Local `YYYY-MM-DD` of the first day of the month before the current one. */
function prevMonthFirstDay(): string {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const month = String(first.getMonth() + 1).padStart(2, '0')
  return `${first.getFullYear()}-${month}-01`
}

describe('DateRangePicker', () => {
  it('keeps the first click while navigating months, then settles a cross-month range', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // An anchor on a mid-month day of the CURRENT month (distinct from the
    // committed 1d endpoints, so its highlight can only come from the anchor).
    const now = new Date()
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const anchorDay = todayKey() === `${monthPrefix}-01` ? `${monthPrefix}-02` : `${monthPrefix}-01`
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(anchorDay))
    // Month navigation keeps the selection progress: navigate away and back,
    // the first click stays highlighted (aria-pressed on the day button).
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText('下个月'))
    expect(screen.getByLabelText(anchorDay).getAttribute('aria-pressed')).toBe('true')
    // The second click lands on the previous month: a cross-month range.
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(prevMonthFirstDay())
    expect(url.searchParams.get('to')).toBe(anchorDay)
  })

  it('discards the pending anchor when Escape closes the popover', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(todayKey()))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '日期范围' })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
    // Reopening starts fresh: the next first click is only an anchor (the
    // panel stays open), so the second click settles a clean range.
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText('上个月'))
    fireEvent.click(screen.getByLabelText(prevMonthFirstDay()))
    expect(screen.getByRole('dialog', { name: '日期范围' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('下个月'))
    fireEvent.click(screen.getByLabelText(todayKey()))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(prevMonthFirstDay())
    expect(url.searchParams.get('to')).toBe(todayKey())
  })

  it('closes on an outside pointerdown and keeps the committed range', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByLabelText(todayKey()))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: '日期范围' })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '日期范围' }).textContent).toBe(`${todayKey()} 至 ${todayKey()}`)
  })

  it('clears the range back to unconstrained', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
    fireEvent.click(screen.getByText('清除范围'))
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBeNull()
    expect(url.searchParams.get('to')).toBeNull()
    await screen.findAllByText('总 token')
    expect(screen.getByRole('button', { name: '日期范围' }).textContent).toBe('全部日期')
    // The unconstrained range reflects as the quick menu's ALL entry.
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('全部日期')
  })
})

describe('MenuSelect', () => {
  /** Local `YYYY-MM-DD` of today shifted by whole days. */
  function dayKey(offsetDays: number): string {
    const date = new Date()
    date.setDate(date.getDate() + offsetDays)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }

  it('marks the selected option while the menu is open', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    expect(screen.getByRole('option', { name: '全部模型' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: 'deepseek-reasoner' }).getAttribute('aria-selected')).toBe('false')
  })

  it('closes the menu without changing the value on Escape', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    fireEvent.click(screen.getByRole('button', { name: '快捷区间' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '快捷区间' }).textContent).toBe('1d')
    // Escape returns focus to the trigger.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '快捷区间' }))
  })

  it('roams the list with the keyboard and commits with Enter', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    const trigger = screen.getByRole('button', { name: '快捷区间' })
    trigger.focus()
    // The trigger's arrow key opens the menu, focus landing on the
    // selected option (1d).
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    // The selected row's text carries its check mark, hence toContain.
    expect((document.activeElement as HTMLElement).textContent).toContain('1d')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect((document.activeElement as HTMLElement).textContent).toContain('7d')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect((document.activeElement as HTMLElement).textContent).toContain('自定义')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect((document.activeElement as HTMLElement).textContent).toContain('1d')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    // Committing closes the menu. (Focus refocusing on the trigger happens
    // inside the handler, but the commit's refetch swaps the section into
    // its loading branch — unmounting the whole filter bar, focus with it —
    // so no focus assertion survives here; the Escape case covers it.)
    expect(screen.queryByRole('listbox')).toBeNull()
    await waitForCall(fetch, 2)
    const url = new URL(String(fetch.mock.calls[1]![0]), 'http://localhost')
    expect(url.searchParams.get('from')).toBe(dayKey(-6))
    expect(url.searchParams.get('to')).toBe(dayKey(0))
  })

  it('opens with focus on the selected option, scrolled into view', async () => {
    stubFetch(async () => ({ ok: true, json: async () => SUMMARY }))
    render(<TokenUsageSection close={() => {}} t={t} />)
    await screen.findAllByText('总 token')
    // Pick a non-first model first, so the re-open must find it mid-list.
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-reasoner' }))
    await screen.findAllByText('总 token')
    // jsdom ships no scrollIntoView; record the elements it is asked to show.
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element): void { scrolled.push(this) }
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute('aria-selected')).toBe('true')
    expect(focused.textContent).toContain('deepseek-reasoner')
    expect(scrolled).toContain(focused)
  })

  it('shows a toast warning when opening a session whose workspace is deleted', async () => {
    const payload: UsageSummary = {
      ...SUMMARY,
      sessionRows: [
        {
          sessionId: 's1',
          title: 'Writing tests',
          cwd: '/repo',
          firstTime: 100,
          lastTime: 200,
          cost: 0.01,
          totals: { requests: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ],
    }
    stubFetch(async () => ({ ok: true, json: async () => payload }))
    const close = vi.fn()
    const openSession = vi.fn(() => ({ ok: false, reason: 'workspaceDeleted' }))
    render(
      <TokenUsageSection
        close={close}
        t={t}
        sessionListed={() => false}
        openSession={openSession}
      />,
    )
    await screen.findAllByText('总 token')
    // Switch to By Session view
    fireEvent.click(screen.getByRole('button', { name: '按会话' }))
    const sessionBtn = await screen.findByText('Writing tests')
    fireEvent.keyDown(window, { key: 'Control' })
    fireEvent.click(sessionBtn)
    expect(openSession).toHaveBeenCalledWith('s1')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('该会话所属工作区已删除，无法跳转')
  })
})

/** Resolve once the stubbed fetch has been called `count` times. */
async function waitForCall(fetch: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (fetch.mock.calls.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(count)
}
