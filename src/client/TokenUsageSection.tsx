/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the filter bar (inclusive day range, model
 * select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
 * total-usage strip, the daily-token trend chart, the per-model detail
 * table with the hit rate last, and — opened by each priced model row's
 * “定价” affordance — a dialog with that model's full price table — all
 * following the active filters. There is no refresh button: entering the
 * page or changing a filter refetches (the route answers no-store); only
 * the error state keeps a retry.
 *
 * @module token-usage/client/TokenUsageSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ContextTier, DailySlot, ModelPricing, ModelRates, RateWindow, UsageSummary } from '../wire.ts'
import { STATS_PATH } from '../wire.ts'
import { useAsyncResource } from './async-resource.ts'
import { DateRangePicker } from './DateRangePicker.tsx'
import { dayKeyOf, shiftedDayKey, totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatRate, formatRateWithSymbol, formatTokens } from './format.ts'
import type { CurrencyView } from './format.ts'
import { HitRateText } from './HitRateText.tsx'
import { MenuSelect } from './MenuSelect.tsx'
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

/** The four base rates of one model as display text (symbol included,
 * converted for a USD view); a missing cache rate bills at the input rate. */
function billedRates(rates: ModelPricing, view: CurrencyView): { input: string; output: string; cacheRead: string; cacheWrite: string } {
  return {
    input: formatRateWithSymbol(rates.inputPerMillion, view),
    output: formatRateWithSymbol(rates.outputPerMillion, view),
    cacheRead: formatRateWithSymbol(rates.cacheReadPerMillion ?? rates.inputPerMillion, view),
    cacheWrite: formatRateWithSymbol(rates.cacheWritePerMillion ?? rates.inputPerMillion, view),
  }
}

/** `HH:MM-HH:MM` of one peak window (half-open, local minutes). */
function windowText(window: RateWindow): string {
  const clock = (minute: number): string =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  return `${clock(window.startMinute)}-${clock(window.endMinute)}`
}

/** The when-it-applies text of one peak slot: its label plus its windows. */
function slotCondition(slot: DailySlot, t: TranslateNS<'token-usage'>): string {
  return `${slot.label ?? t('pricing.peak')} ${slot.windows.map(windowText).join(t('pricing.windowSep'))}`
}

/**
 * One price row of the pricing table: the condition that bills at these
 * rates, and the four rates themselves. The condition text is complete —
 * a peak row inside a tier carries both the threshold and the windows —
 * so the row order never carries meaning on its own.
 */
interface PriceRow {
  condition: string
  rates: ModelPricing
}

/**
 * The price rows of one rate node (a time rule's or the model root's): the
 * node's own base rates, then its peak slots, then its context tiers
 * (ascending), each tier followed by the peak slots hanging on that tier —
 * mirroring {@link resolveRate}'s node chain, where a matching tier's slots
 * replace the node's and peak rates replace the node's rates wholesale.
 */
function nodePriceRows(node: { rates: ModelPricing; tiers?: ContextTier[] | undefined; slots?: DailySlot[] | undefined }, t: TranslateNS<'token-usage'>): PriceRow[] {
  const rows: PriceRow[] = [{ condition: t('pricing.default'), rates: node.rates }]
  const tiers = [...node.tiers ?? []].sort((a, b) => a.threshold - b.threshold)
  for (const tier of tiers) {
    const tierCondition = t('pricing.tier', { threshold: formatTokens(tier.threshold) })
    rows.push({ condition: tierCondition, rates: tier.rates })
    for (const slot of tier.dailySlots ?? []) {
      rows.push({ condition: `${tierCondition} · ${slotCondition(slot, t)}`, rates: slot.rates })
    }
  }
  for (const slot of node.slots ?? []) {
    rows.push({ condition: slotCondition(slot, t), rates: slot.rates })
  }
  return rows
}

/**
 * One model's price table: rows are billing conditions — grouped into the
 * model root (“常规”, omitted when it is the only group) and one group per
 * time rule with its date window — so tier, peak, and time-rule pricing
 * each show when they apply and what they bill. Shared by the pricing
 * dialog; the structure mirrors {@link resolveRate}'s node chain.
 */
function ModelPriceTable({ rules, view, t }: {
  rules: ModelRates
  view: CurrencyView
  t: TranslateNS<'token-usage'>
}): ReactNode {
  // Groups follow resolveRate's chain: the model root (the current era)
  // first, then each time rule as an isolated price world, newest era
  // first (descending rule end), regardless of the feed's listing order.
  const groups = [
    {
      title: rules.timeRules.length > 0 ? t('pricing.regular') : null,
      rows: nodePriceRows({ rates: rules.base, tiers: rules.contextTiers, slots: rules.dailySlots }, t),
    },
    ...[...rules.timeRules]
      .sort((a, b) => b.endTime - a.endTime)
      .map(rule => ({
      // A zero start (the “since forever” rules some feeds carry) drops
      // the bogus 1970 date and reads as “through <end>”.
      title: `${rule.label !== undefined ? `${rule.label} ` : ''}${rule.startTime > 0 ? `${dayKeyOf(new Date(rule.startTime * 1000))} ~ ` : '~ '}${dayKeyOf(new Date(rule.endTime * 1000))}`,
      rows: nodePriceRows({ rates: rule.rates, tiers: rule.contextTiers, slots: rule.dailySlots }, t),
    })),
  ]
  return (
    <div className={styles['tableWrap']}>
      <table className={styles['table']} aria-label={t('pricing.title')}>
        <thead>
          <tr>
            <th className={styles['conditionHead']}>{t('pricing.condition')}</th>
            <th>{t('pricing.input')}{t('pricing.perMillion')}</th>
            <th>{t('pricing.output')}{t('pricing.perMillion')}</th>
            <th>{t('pricing.cacheRead')}{t('pricing.perMillion')}</th>
            <th>{t('pricing.cacheWrite')}{t('pricing.perMillion')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.flatMap(group => [
            ...(group.title !== null
              ? [
                <tr key={group.title} className={styles['groupRow']}>
                  <td colSpan={5}>{group.title}</td>
                </tr>,
              ]
              : []),
            ...group.rows.map((row, index) => {
              const billed = billedRates(row.rates, view)
              return (
                <tr key={`${group.title ?? ''}-${index}-${row.condition}`}>
                  <td className={styles['conditionCell']}>{row.condition}</td>
                  <td>{billed.input}</td>
                  <td>{billed.output}</td>
                  <td>{billed.cacheRead}</td>
                  <td>{billed.cacheWrite}</td>
                </tr>
              )
            }),
          ])}
        </tbody>
      </table>
      {view.symbol === '$'
        ? <p className={styles['rateNote']}>{t('pricing.exchangeRateNote', { rate: formatRate(view.rate) })}</p>
        : null}
    </div>
  )
}

/**
 * The pricing dialog of one model: a native `<dialog>` (Esc closes, focus
 * is trapped, the backdrop dims, and the top layer renders it above the
 * table's scroll shell) opened by the “定价” affordance in a model row.
 * Mounts only while a model is selected; every close path funnels through
 * the dialog's `close` event, which clears the selection and unmounts it.
 */
function PricingDialog({ model, rules, view, onClose, t }: {
  model: string
  rules: ModelRates
  view: CurrencyView
  onClose: () => void
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className={styles['dialog']}
      aria-label={t('pricing.title')}
      onClose={onClose}
      // A click that landed on the dialog element itself hit the backdrop
      // (the content sits in child elements), which closes like Esc does.
      onClick={event => { if (event.target === dialogRef.current) dialogRef.current?.close() }}
    >
      <div className={styles['dialogHead']}>
        <span className={styles['dialogTitle']}>{model}</span>
        <button
          type="button"
          className={styles['dialogClose']}
          aria-label={t('pricing.close')}
          onClick={() => dialogRef.current?.close()}
        >
          ✕
        </button>
      </div>
      <ModelPriceTable rules={rules} view={view} t={t} />
    </dialog>
  )
}

/** Quick-range menu entries (labels are locale-free day counts). */
const QUICK_OPTIONS = [
  { value: '1', label: '1d' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
] as const

/** The filter bar: quick range menu, day-range picker popover, model
 * menu — one row, one popover language. */
function FilterBar({ filters, models, onChange, t }: {
  filters: Filters
  models: readonly string[]
  onChange: (next: Filters) => void
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
      <FilterBar filters={filters} models={models} onChange={setFilters} t={t} />
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
