/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the filter bar (inclusive day range, model
 * select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
 * total-usage strip, the daily-token trend chart, and the per-model detail
 * table with the hit rate last — all following the active filters. A
 * priced model name is the row's price affordance (one click opens
 * PricingDialog.tsx); unpriced rows keep the in-cell tag. The filter
 * row's tail link opens the filter-free pricing-overview dialog
 * (PricingOverviewDialog.tsx). There is no refresh
 * button: entering the page or changing a filter refetches (the route
 * answers no-store); only the error state keeps a retry.
 *
 * @module token-usage/client/TokenUsageSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UsageSummary } from '../wire.ts'
import { STATS_PATH } from '../wire.ts'
import { useAsyncResource } from './async-resource.ts'
import { DateRangePicker } from './DateRangePicker.tsx'
import { shiftedDayKey } from './day.ts'
import { currencyViewOf } from './format.ts'
import { MenuSelect } from './MenuSelect.tsx'
import { DashboardCards } from './DashboardCards.tsx'
import { OverheadRows } from './OverheadRows.tsx'
import { OverviewBoard } from './OverviewBoard.tsx'
import { PricingDialog } from './PricingDialog.tsx'
import { PricingOverviewDialog } from './PricingOverviewDialog.tsx'
import { PricingAssociationProvider } from './PricingAssociations.tsx'
import { usePricingAssociationRefresh } from './pricing-associations.ts'
import { UsageRows, RowSortControl, PerfToggle } from './UsageRows.tsx'
import type { RowSort } from './UsageRows.tsx'
import { projectRowsOf } from './project-rows.ts'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import styles from './TokenUsageSection.module.css'

/** The three tabs' fixed sort options: projects and models pick between
 * token size and billed cost; sessions add last activity. */
const PROJECT_SORT: readonly RowSort[] = ['tokens', 'cost']
const MODEL_SORT: readonly RowSort[] = ['tokens', 'cost']
const SESSION_SORT: readonly RowSort[] = ['tokens', 'cost', 'recent']

/** Re-export so existing section tests and consumers keep importing
 * `StatCard` from this module (the file moved to `./StatCard.tsx`). */
export { StatCard } from './StatCard.tsx'

// Re-exported for tests and sibling consumers; the implementations live in
// the leaf modules (day / format) so the chart can share them without a cycle.
export { totalTokens } from './day.ts'
export { formatTokens, formatHitRate } from './format.ts'

/** The active filter selection; '' means unconstrained. */
interface Filters {
  from: string
  to: string
  model: string
}

/** Fetch the summary for one query string; the caller owns the failure
 * presentation. The AbortSignal wires into the request so a filter change
 * cancels the in-flight fetch instead of letting its response overwrite
 * the next filter's data. */
function fetchSummary(query: string, signal: AbortSignal): Promise<UsageSummary> {
  return fetch(STATS_PATH + query, { signal })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return response.json() as Promise<UsageSummary>
    })
    .then(value => {
      if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
        throw new Error('unexpected stats response')
      }
      return value
    })
}

/**
 * The query string of one filter selection ('' when unconstrained), or null
 * while the range is mid-edit (`from > to`): editing the two date inputs
 * one at a time passes through inverted ranges, and fetching those would
 * only flash an HTTP 400 — the request waits until the range settles.
 */
function filterQuery(filters: Filters): string | null {
  if (filters.from !== '' && filters.to !== '' && filters.from > filters.to) return null
  const params = new URLSearchParams()
  if (filters.from !== '') params.set('from', filters.from)
  if (filters.to !== '') params.set('to', filters.to)
  if (filters.model !== '') params.set('model', filters.model)
  return Array.from(params).length > 0 ? `?${params.toString()}` : ''
}

/** The day keys of one quick range: today minus (days - 1) through today. */
function quickRange(days: number): { from: string; to: string } {
  return { from: shiftedDayKey(-(days - 1)), to: shiftedDayKey(0) }
}

/** Whether the filters exactly hold one quick range. */
function isQuickActive(days: number, filters: Filters): boolean {
  const range = quickRange(days)
  return filters.from === range.from && filters.to === range.to
}

/** Quick-range menu entries (labels are locale-free day counts). */
const QUICK_OPTIONS = [
  { value: '1', label: '1d' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
] as const

/** The filter bar: quick range menu, day-range picker popover, model
 * menu — one row, one popover language. The row's tail link is an action,
 * not a selector: it opens the filter-free pricing overview. */
function FilterBar({ filters, models, onChange, onPricingTable, t }: {
  filters: Filters
  models: readonly string[]
  onChange: (next: Filters) => void
  onPricingTable: () => void
  t: TranslateNS<'token-usage'>
}): ReactNode {
  // 'all' when the range is unconstrained, 'custom' when it no longer
  // holds one of the quick ranges.
  const quickValue = QUICK_OPTIONS.find(option => isQuickActive(Number(option.value), filters))?.value
    ?? (filters.from === '' && filters.to === '' ? 'all' : 'custom')
  return (
    <div className={styles['filters']}>
      <MenuSelect
        ariaLabel={t('filter.quickRange')}
        value={quickValue}
        options={[
          ...QUICK_OPTIONS,
          { value: 'all', label: t('filter.allDates') },
          { value: 'custom', label: t('filter.custom') },
        ]}
        onChange={value => {
          // 'all' releases the range back to unconstrained; the 'custom'
          // entry is informational: it mirrors the day range and never
          // rewrites it.
          if (value === 'all') onChange({ ...filters, from: '', to: '' })
          const days = Number(value)
          if (days > 0) onChange({ ...filters, ...quickRange(days) })
        }}
      />
      <DateRangePicker
        from={filters.from}
        to={filters.to}
        onChange={next => onChange({ ...filters, ...next })}
        t={t}
      />
      <MenuSelect
        ariaLabel={t('filter.model')}
        grow
        value={filters.model}
        options={[{ value: '', label: t('filter.allModels') }, ...models.map(model => ({ value: model, label: model }))]}
        onChange={model => onChange({ ...filters, model })}
      />
      {/* The tail action of the tool row: opens the pricing overview, a
       * view independent of the three selectors (it never takes filters).
       * A link-styled label, not a bordered button — bordered reads as a
       * fourth selector of the same family. */}
      <button type="button" data-pricing-overview-trigger className={styles['pricingLink']} onClick={onPricingTable}>
        {t('pricing.table')}
      </button>
    </div>
  )
}

/**
 * Render the Token Usage section content column. The `t` seat arrives from
 * the registration's `locale:` declaration and follows the active locale.
 * The session jump seats (`sessionListed` / `openSession`) come from the
 * registration's `inject:` — the session table's Ctrl+click affordance
 * reads the controller's list and opens the target session.
 * @param props - the framework-injected translate seat, the optional
 * injected jump seats, and the optional `close` the hosting surface hands
 * in (the settings panel closes itself on a jump; the main page returns
 * to the conversation). Absent `close` just skips the dismiss step.
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection({ t, close, sessionListed, openSession, variant }: {
  t: TranslateNS<'token-usage'>
  /** Dismiss the hosting surface after a successful session jump. */
  close?: (() => void) | undefined
  sessionListed?: ((id: string) => boolean) | undefined
  openSession?: ((id: string) => boolean | { ok: boolean; reason?: string }) | undefined
  /** Hosting surface: the settings panel (default) or the main-column page,
   * which only restyles the title step and lifts the table's height cap. */
  variant?: ('panel' | 'page') | undefined
}): ReactNode {
  const rootClass = variant === 'page' ? `${styles['section']} ${styles['pageVariant']}` : styles['section']
  const rootRef = useRef<HTMLDivElement>(null)
  useColorSchemeMirror(rootRef)
  const [toastText, setToastText] = useState<string | null>(null)
  const [toastSeq, setToastSeq] = useState(0)
  const showToast = useCallback((text: string) => {
    setToastSeq(previous => previous + 1)
    setToastText(text)
  }, [])
  const dismissToast = useCallback(() => {
    setToastText(null)
  }, [])

  const handleOpenSession = useCallback((id: string) => {
    if (!openSession) return
    const result = openSession(id)
    if (result && typeof result === 'object' && 'ok' in result) {
      if (result.ok) {
        close?.()
      } else if (result.reason === 'workspaceDeleted') {
        showToast(t('session.workspaceDeleted'))
      }
      return
    }
    if (result === true) {
      close?.()
    }
  }, [openSession, close, showToast, t])

  // Entering the page starts on today's window (the 1d quick range).
  const [filters, setFilters] = useState<Filters>(() => ({ model: '', ...quickRange(1) }))
  // The detail-table block's mode: by project (default — the dashboards'
  // first tab), by model, by session, or the runtime-overhead breakdown of
  // the auxiliary (bypass) model requests. Pure presentation state — every
  // row set arrives on the SAME summary response, so switching never
  // refetches (session-local, not persisted, the usage tab's scope-switch
  // tradeoff).
  const [detailMode, setDetailMode] = useState<'project' | 'model' | 'session' | 'aux'>('project')
  // The three lists' sorts, each its own state (the page's cards and the
  // panel's tabs render the same lists, so one state drives both): projects
  // and models pick token size vs billed cost, sessions add last activity.
  // A pick matching the native order passes it straight through.
  const [projectSort, setProjectSort] = useState<RowSort>('tokens')
  const [modelSort, setModelSort] = useState<RowSort>('tokens')
  // The models' performance view — a content switch next to the sort
  // control (shared by the page card and the panel tab, like the sorts).
  const [modelPerfView, setModelPerfView] = useState(false)
  const [sessionSort, setSessionSort] = useState<RowSort>('cost')
  // Ctrl+click on a model row toggles the model filter to just that model
  // (a single pick — clicking the filtered model again clears it).
  const handleToggleModel = useCallback((model: string) => {
    setFilters(previous => ({ ...previous, model: previous.model === model ? '' : model }))
  }, [])
  // The overhead pill's destination: the page scrolls to (and flashes) the
  // dashboard's overhead card; the panel switches to the overhead tab.
  const overheadCardRef = useRef<HTMLDivElement | null>(null)
  const [overheadFlash, setOverheadFlash] = useState(false)
  const flashTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(flashTimer.current), [])
  const activateOverhead = useCallback(() => {
    if (variant === 'page') {
      overheadCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setOverheadFlash(true)
      window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setOverheadFlash(false), 1200)
    } else {
      setDetailMode('aux')
    }
  }, [variant])
  const [models, setModels] = useState<string[]>([])
  // The model whose pricing dialog is open (null = none). Refetched
  // summaries keep the dialog's rules in sync with the latest pricing.
  const [detailModel, setDetailModel] = useState<string | null>(null)
  // The pricing-overview dialog (opened by the filter row's tail link).
  // `usedSnapshot` is taken at open time: the modal's backdrop covers the
  // filter row, so the filters cannot change while it is open and the
  // snapshot stays stable for the whole dialog session. The link renders
  // only in the ready branch, so the summary is always at hand here.
  const [pricingTableOpen, setPricingTableOpen] = useState(false)
  const [usedSnapshot, setUsedSnapshot] = useState<ReadonlySet<string>>(() => new Set())
  const [retryToken, setRetryToken] = useState(0)
  const lastSummary = useRef<UsageSummary | null>(null)
  const retry = useCallback(() => { setRetryToken(previous => previous + 1) }, [])
  usePricingAssociationRefresh(retry)

  const query = filterQuery(filters)
  // A mid-edit inverted range (`query === null`) is fed to the hook as the
  // last valid query — the ref remembers the most recent non-null string
  // and stays stable while the user types a bad range, so the hook does
  // neither fire a fetch nor flash its loading state. The test pins this
  // contract: bad ranges must not produce a network round-trip.
  const lastValidQueryRef = useRef<string>(query ?? '')
  if (query !== null) lastValidQueryRef.current = query
  const fetchQuery = query ?? lastValidQueryRef.current
  const [state] = useAsyncResource<UsageSummary>(
    signal => fetchSummary(fetchQuery, signal),
    [fetchQuery, retryToken],
    { silentAfterFirst: false, retryToken },
  )

  // While every model is shown, keep the option list from collapsing to
  // the filtered selection. The side effect runs when the ready-state
  // summary lands, not on every render.
  useEffect(() => {
    if (state.status !== 'ready') return
    if (filters.model !== '') return
    const next = state.value.byModel.map(row => row.model)
    if (next.length === models.length && next.every((m, i) => m === models[i])) return
    setModels(next)
  }, [state, filters.model, models])

  if (state.status === 'ready') lastSummary.current = state.value
  const retainedView = lastSummary.current !== null ? currencyViewOf(lastSummary.current) : { symbol: '￥' as const, rate: 1 }
  const pricingOverview = pricingTableOpen ? <PricingOverviewDialog usedModels={usedSnapshot} view={retainedView}
    onClose={() => setPricingTableOpen(false)} t={t} /> : null
  if (state.status === 'loading') {
    return (
      <div ref={rootRef} className={rootClass}>
        <PricingAssociationProvider resolutions={lastSummary.current?.modelResolutions} feedVersion={lastSummary.current?.feedVersion} view={retainedView} t={t}>
        {pricingOverview}
        <h2 className={styles['title']}>{t('nav.label')}</h2>
        <p className={styles['muted']}>{t('loading')}</p>
        </PricingAssociationProvider>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div ref={rootRef} className={rootClass}>
        <PricingAssociationProvider resolutions={lastSummary.current?.modelResolutions} feedVersion={lastSummary.current?.feedVersion} view={retainedView} t={t}>
        {pricingOverview}
        <div className={styles['head']}>
          <h2 className={styles['title']}>{t('nav.label')}</h2>
          <button type="button" className={styles['button']} onClick={retry}>{t('retry')}</button>
        </div>
        <p className={styles['error']}>{t('loadFailed', { message: state.message })}</p>
        </PricingAssociationProvider>
      </div>
    )
  }

  const { total } = state.value
  const view = currencyViewOf(state.value)
  // New hosts aggregate before the session top-N cut. Older payloads retain
  // the former client-side fold as a compatibility fallback only.
  const projectRows = state.value.projectRows ?? projectRowsOf(state.value.sessionRows ?? [])
  // The auxiliary (bypass) request count: the runtime-overhead tab is part of
  // the detail switch whenever any dimension has rows, and the tab content
  // renders its own empty hint when this stays 0 (or an older host payload
  // carries no auxiliary layer at all).
  const auxRequests = state.value.aux?.total.requests ?? 0
  return (
    <div ref={rootRef} className={rootClass}>
    <PricingAssociationProvider resolutions={state.value.modelResolutions} feedVersion={state.value.feedVersion} view={view} t={t}>
      {pricingOverview}
      <h2 className={styles['title']}>{t('nav.label')}</h2>
      <p className={styles['muted']}>{t('dataDir', { path: state.value.dataDir })}</p>
      <FilterBar
        filters={filters}
        models={models}
        onChange={setFilters}
        onPricingTable={() => {
          setUsedSnapshot(new Set(state.value.byModel.map(row => row.model)))
          setPricingTableOpen(true)
        }}
        t={t}
      />
      {total.requests === 0 && (total.failures ?? 0) === 0
        ? (
          // One hint covers both an empty log and an empty filtered window:
          // the page opens on today (1d), so the two are indistinguishable
          // from the filtered response alone. The pricing block follows the
          // filter selection, so an empty selection renders none of it.
          <p className={styles['empty']}>
            {t('empty')}
          </p>
        )
        : (
          <>
            <OverviewBoard
              total={total}
              totalCost={state.value.totalCost}
              costState={state.value.costState}
              pricingUnavailableReason={state.value.pricingUnavailableReason}
              associationStorageError={state.value.associationStorageError}
              aux={state.value.aux}
              byDay={state.value.byDay}
              byHour={state.value.byHour}
              from={filters.from}
              to={filters.to}
              onOverheadActivate={activateOverhead}
              {...variant === 'page' ? {} : { compact: true }}
              view={view}
              t={t}
            />
            {variant === 'page'
              ? (
                // The main page's dashboard: the four equal-height cards,
                // no dimension switch — everything is on show at once.
                <DashboardCards
                  projectRows={projectRows}
                  modelRows={state.value.byModel}
                  sessionRows={state.value.sessionRows ?? []}
                  projectSort={projectSort}
                  onProjectSortChange={setProjectSort}
                  modelSort={modelSort}
                  onModelSortChange={setModelSort}
                  modelPerfView={modelPerfView}
                  onModelPerfToggle={setModelPerfView}
                  sessionSort={sessionSort}
                  onSessionSortChange={setSessionSort}
                  aux={state.value.aux}
                  pricing={state.value.pricing}
                  costState={state.value.costState}
                  view={view}
                  t={t}
                  {...sessionListed !== undefined && openSession !== undefined
                    ? { sessionListed, onSessionOpen: handleOpenSession }
                    : {}}
                  onToggleModel={handleToggleModel}
                  onModelName={setDetailModel}
                  overheadCardRef={overheadCardRef}
                  overheadFlash={overheadFlash}
                />
              )
              : state.value.byModel.length > 0 || (state.value.sessionRows?.length ?? 0) > 0 || auxRequests > 0
              ? (
                <section className={styles['detailPanel']}>
                  <div className={styles['detailToolbar']}>
                    <div className={styles['segmented']} role="group" aria-label={t('detail.switch.label')}>
                      {(['project', 'model', 'session', 'aux'] as const).map(mode => (
                        <button
                          key={mode}
                          type="button"
                          className={detailMode === mode ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
                          aria-pressed={detailMode === mode}
                          onClick={() => setDetailMode(mode)}
                        >
                          {t(mode === 'project' ? 'byProject.title' : mode === 'model' ? 'byModel.title' : mode === 'session' ? 'bySession.title' : 'aux.tab')}
                        </button>
                      ))}
                    </div>
                    {detailMode !== 'aux' && (
                      <div className={styles['sortRow']}>
                        <span className={detailMode === 'model' && modelPerfView ? styles['sortHidden'] : undefined}>
                          <RowSortControl
                            compact
                            value={detailMode === 'project' ? projectSort : detailMode === 'model' ? modelSort : sessionSort}
                            options={detailMode === 'project' ? PROJECT_SORT : detailMode === 'model' ? MODEL_SORT : SESSION_SORT}
                            onChange={detailMode === 'project' ? setProjectSort : detailMode === 'model' ? setModelSort : setSessionSort}
                            ariaLabel={t(detailMode === 'project' ? 'byProject.title' : detailMode === 'model' ? 'byModel.title' : 'bySession.title')}
                            t={t}
                          />
                        </span>
                        {detailMode === 'model' && <PerfToggle compact pressed={modelPerfView} onToggle={setModelPerfView} t={t} />}
                      </div>
                    )}
                  </div>
                  <div className={styles['detailBody']}>
                    {detailMode === 'aux'
                      ? <OverheadRows compact aux={state.value.aux} costState={state.value.costState} view={view} t={t} />
                      : <UsageRows
                          key={detailMode}
                          compact
                          kind={detailMode}
                          projectRows={projectRows}
                          modelRows={state.value.byModel}
                          sessionRows={state.value.sessionRows ?? []}
                          sort={detailMode === 'project' ? projectSort : detailMode === 'model' ? modelSort : sessionSort}
                          perfView={detailMode === 'model' && modelPerfView}
                          pricing={state.value.pricing}
                          costState={state.value.costState}
                          view={view}
                          t={t}
                          onToggleModel={handleToggleModel}
                          onModelName={setDetailModel}
                          {...sessionListed !== undefined && openSession !== undefined
                            ? { sessionListed, onSessionOpen: handleOpenSession }
                            : {}}
                        />}
                  </div>
                </section>
              )
              : null}
            {detailModel !== null && state.value.pricing[detailModel] !== undefined
              ? (
                <PricingDialog
                  model={detailModel}
                  rules={state.value.pricing[detailModel]!}
                  view={view}
                  onClose={() => setDetailModel(null)}
                  t={t}
                />
              )
              : null}
          </>
        )}
      {toastText !== null && (
        <Toast
          key={toastSeq}
          text={toastText}
          icon={<IconWarningOutlineRegular />}
          onDone={dismissToast}
        />
      )}
    </PricingAssociationProvider>
    </div>
  )
}
