/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the filter bar (inclusive day range, model
 * select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
 * total-usage strip, the daily-token trend chart, and the per-model detail
 * table with the hit rate last — all following the active filters. Each
 * priced model row's “定价” affordance opens that model's price dialog
 * (PricingDialog.tsx); the filter row's tail link opens the filter-free
 * pricing-overview dialog (PricingOverviewDialog.tsx). There is no refresh
 * button: entering the page or changing a filter refetches (the route
 * answers no-store); only the error state keeps a retry.
 *
 * @module token-usage/client/TokenUsageSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageSummary } from '../wire.ts'
import { STATS_PATH } from '../wire.ts'
import { useAsyncResource } from './async-resource.ts'
import { DateRangePicker } from './DateRangePicker.tsx'
import { shiftedDayKey, totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatTokens } from './format.ts'
import { HitRateText } from './HitRateText.tsx'
import { MenuSelect } from './MenuSelect.tsx'
import { PricingDialog } from './PricingDialog.tsx'
import { PricingOverviewDialog } from './PricingOverviewDialog.tsx'
import { RequestsCell, RequestsSplitHead, RequestsStatCard, StatCard } from './StatCard.tsx'
import { TrendChart } from './TrendChart.tsx'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import styles from './TokenUsageSection.module.css'

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
      <button type="button" className={styles['pricingLink']} onClick={onPricingTable}>
        {t('pricing.table')}
      </button>
    </div>
  )
}

/**
 * Render the Token Usage section content column. The `t` seat arrives from
 * the registration's `locale:` declaration and follows the active locale.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel) plus the framework-injected translate seat.
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection({ t }: SettingsSectionOwnerProps & { t: TranslateNS<'token-usage'> }): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null)
  useColorSchemeMirror(rootRef)
  // Entering the page starts on today's window (the 1d quick range).
  const [filters, setFilters] = useState<Filters>(() => ({ model: '', ...quickRange(1) }))
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
  const retry = useCallback(() => { setRetryToken(previous => previous + 1) }, [])

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

  if (state.status === 'loading') {
    return (
      <div ref={rootRef} className={styles['section']}>
        <h2 className={styles['title']}>{t('nav.label')}</h2>
        <p className={styles['muted']}>{t('loading')}</p>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div ref={rootRef} className={styles['section']}>
        <div className={styles['head']}>
          <h2 className={styles['title']}>{t('nav.label')}</h2>
          <button type="button" className={styles['button']} onClick={retry}>{t('retry')}</button>
        </div>
        <p className={styles['error']}>{t('loadFailed', { message: state.message })}</p>
      </div>
    )
  }

  const { total } = state.value
  const view = currencyViewOf(state.value)
  return (
    <div ref={rootRef} className={styles['section']}>
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
      {pricingTableOpen
        ? (
          // The overview is independent of the filters and of the empty-
          // state branch below: even a day with no usage still has a full
          // pricing table worth browsing.
          <PricingOverviewDialog
            usedModels={usedSnapshot}
            view={view}
            onClose={() => setPricingTableOpen(false)}
            t={t}
          />
        )
        : null}
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
            <div className={styles['cards']}>
              <RequestsStatCard
                requests={total.requests}
                failures={total.failures ?? 0}
                failuresByCode={total.failuresByCode}
                t={t}
              />
              <StatCard label={t('stat.cost')} value={formatCost(state.value.totalCost, view)} />
              <StatCard label={t('stat.totalTokens')} value={formatTokens(totalTokens(total))} />
              <StatCard label={t('stat.hitRate')} value={<HitRateText totals={total} />} />
            </div>
            <div className={styles['cards']}>
              <StatCard label={t('stat.input')} value={formatTokens(total.inputTokens)} />
              <StatCard label={t('stat.output')} value={formatTokens(total.outputTokens)} />
              <StatCard label={t('stat.cacheRead')} value={formatTokens(total.cacheReadTokens)} />
              <StatCard label={t('stat.cacheWrite')} value={formatTokens(total.cacheWriteTokens)} />
            </div>
            {state.value.unpricedModels.length > 0
              ? (
                <p className={styles['warning']} role="status">
                  {t('unpriced.warning', {
                    count: String(state.value.unpricedModels.length),
                    models: state.value.unpricedModels.join(', '),
                    zero: formatCost(0, view),
                  })}
                </p>
              )
              : null}
            <TrendChart
              rows={state.value.byDay}
              t={t}
              {...filters.from !== '' ? { from: filters.from } : {}}
              {...filters.to !== '' ? { to: filters.to } : {}}
              // A single-day window (the 1d quick range or a same-day custom
              // selection) plots the day's 24 hours instead of one point.
              {...filters.from !== '' && filters.from === filters.to ? { hours: state.value.byHour } : {}}
            />
            {state.value.byModel.length > 0
              ? (
                <>
                  <h3 className={styles['subtitle']}>{t('byModel.title')}</h3>
                  <div className={styles['tableWrap']}>
                    <table className={styles['table']} aria-label={t('byModel.title')}>
                      <thead>
                        <tr>
                          <th className={styles['modelHead']}>{t('filter.model')}</th>
                          <th aria-label={t('stat.successFail')}><RequestsSplitHead t={t} /></th>
                          <th>{t('stat.cost')}</th>
                          <th>{t('stat.totalTokens')}</th>
                          <th>{t('stat.input')}</th>
                          <th>{t('stat.output')}</th>
                          <th>{t('stat.cacheRead')}</th>
                          <th>{t('stat.cacheWrite')}</th>
                          <th>{t('stat.hitRate')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.value.byModel.map(row => {
                          const rules = state.value.pricing[row.model]
                          return (
                            <tr key={row.model}>
                              <td className={styles['modelCol']}>
                                <span className={styles['modelCell']}>
                                  <span className={styles['modelName']}>{row.model}</span>
                                  {rules !== undefined
                                    ? (
                                      // The pricing affordance: one click opens
                                      // the model's detail-price dialog.
                                      <button
                                        type="button"
                                        className={styles['pricingButton']}
                                        aria-label={t('pricing.view', { model: row.model })}
                                        onClick={() => setDetailModel(row.model)}
                                      >
                                        {t('pricing.viewShort')}
                                      </button>
                                    )
                                    : (
                                      // The unpriced tag explains the em-dash
                                      // cost cell in place.
                                      <span className={styles['unpricedTag']}>{t('pricing.unpriced')}</span>
                                    )}
                                </span>
                              </td>
                              <td>
                                <RequestsCell
                                  requests={row.totals.requests}
                                  failures={row.totals.failures ?? 0}
                                  failuresByCode={row.totals.failuresByCode}
                                  t={t}
                                />
                              </td>
                              <td>
                                {rules !== undefined ? formatCost(row.cost, view) : '—'}
                              </td>
                              <td>{formatTokens(totalTokens(row.totals))}</td>
                              <td>{formatTokens(row.totals.inputTokens)}</td>
                              <td>{formatTokens(row.totals.outputTokens)}</td>
                              <td>{formatTokens(row.totals.cacheReadTokens)}</td>
                              <td>{formatTokens(row.totals.cacheWriteTokens)}</td>
                              <td><HitRateText totals={row.totals} /></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
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
    </div>
  )
}
