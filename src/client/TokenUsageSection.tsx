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

import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ContextTier, DailySlot, ModelPricing, ModelRates, RateWindow, UsageSummary } from '../wire.ts'
import { STATS_PATH } from '../wire.ts'
import { dayKeyOf, shiftedDayKey, totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatHitRate, formatRate, formatRateWithSymbol, formatTokens } from './format.ts'
import type { CurrencyView } from './format.ts'
import { TrendChart } from './TrendChart.tsx'
import styles from './TokenUsageSection.module.css'

// Re-exported for tests and sibling consumers; the implementations live in
// the leaf modules (day / format) so the chart can share them without a cycle.
export { totalTokens } from './day.ts'
export { formatTokens, formatHitRate } from './format.ts'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: UsageSummary }

/** The active filter selection; '' means unconstrained. */
interface Filters {
  from: string
  to: string
  model: string
}

/** Fetch the summary for one query string; the caller owns the failure presentation. */
async function fetchSummary(query: string): Promise<UsageSummary> {
  const response = await fetch(STATS_PATH + query)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value = (await response.json()) as UsageSummary
  if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
    throw new Error('unexpected stats response')
  }
  return value
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

/** Quick-range day span in days (1 = today only, inclusive on both ends). */
const QUICK_DAYS = [1, 7, 30] as const

/** The day keys of one quick range: today minus (days - 1) through today. */
function quickRange(days: number): { from: string; to: string } {
  return { from: shiftedDayKey(-(days - 1)), to: shiftedDayKey(0) }
}

/** Whether the filters exactly hold one quick range. */
function isQuickActive(days: number, filters: Filters): boolean {
  const range = quickRange(days)
  return filters.from === range.from && filters.to === range.to
}

/** One card in a metric row; `accent` renders the value in the cost color. */
function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }): ReactNode {
  return (
    <div className={styles['card']}>
      <span className={styles['cardLabel']}>{label}</span>
      <span className={accent === true ? styles['cardValueCost'] : styles['cardValue']}>{value}</span>
    </div>
  )
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
  // Groups follow resolveRate's chain: the model root, then each time rule
  // with its own tiers/slots as an isolated price world.
  const groups = [
    {
      title: rules.timeRules.length > 0 ? t('pricing.regular') : null,
      rows: nodePriceRows({ rates: rules.base, tiers: rules.contextTiers, slots: rules.dailySlots }, t),
    },
    ...rules.timeRules.map(rule => ({
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

/** The filter bar: quick range select, day range, model select — one row. */
function FilterBar({ filters, models, onChange, t }: {
  filters: Filters
  models: readonly string[]
  onChange: (next: Filters) => void
  t: TranslateNS<'token-usage'>
}): ReactNode {
  // 'custom' when the day inputs no longer hold one of the quick ranges.
  const quickValue = QUICK_DAYS.find(days => isQuickActive(days, filters)) ?? 'custom'
  return (
    <div className={styles['filters']}>
      <select
        aria-label={t('filter.quickRange')}
        className={styles['control']}
        value={quickValue}
        onChange={event => {
          const days = Number(event.target.value)
          if (days > 0) onChange({ ...filters, ...quickRange(days) })
        }}
      >
        <option value="1">1d</option>
        <option value="7">7d</option>
        <option value="30">30d</option>
        <option value="custom">{t('filter.custom')}</option>
      </select>
      <input
        type="date"
        aria-label={t('filter.from')}
        className={styles['dateControl']}
        value={filters.from}
        onChange={event => onChange({ ...filters, from: event.target.value })}
      />
      <span className={styles['rangeSeparator']}>{t('filter.separator')}</span>
      <input
        type="date"
        aria-label={t('filter.to')}
        className={styles['dateControl']}
        value={filters.to}
        onChange={event => onChange({ ...filters, to: event.target.value })}
      />
      <select
        aria-label={t('filter.model')}
        className={styles['modelControl']}
        value={filters.model}
        onChange={event => onChange({ ...filters, model: event.target.value })}
      >
        <option value="">{t('filter.allModels')}</option>
        {models.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
    </div>
  )
}

/**
 * Mirror the shell's root `color-scheme` onto this section's root element.
 * The shell sets it on `document.documentElement` only, so form controls
 * inside a plugin section render with the UA default (white) in dark mode;
 * scoping the property to the section fixes selects, inputs, and the
 * dialog without touching anything outside the section.
 */
function useColorSchemeMirror(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = document.documentElement
    const element = rootRef.current
    if (element === null) return
    const sync = (): void => {
      const scheme = root.style.colorScheme
      if (scheme !== '') element.style.colorScheme = scheme
      else element.style.removeProperty('color-scheme')
    }
    sync()
    // The shell rewrites the inline style on every theme switch.
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [rootRef])
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
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Entering the page starts on today's window (the 1d quick range).
  const [filters, setFilters] = useState<Filters>(() => ({ model: '', ...quickRange(1) }))
  const [models, setModels] = useState<string[]>([])
  // The model whose pricing dialog is open (null = none). Refetched
  // summaries keep the dialog's rules in sync with the latest pricing.
  const [detailModel, setDetailModel] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setAttempt(previous => previous + 1) }, [])

  useEffect(() => {
    const query = filterQuery(filters)
    // A mid-edit inverted range keeps the current data until it settles.
    if (query === null) return
    let cancelled = false
    setState({ status: 'loading' })
    void fetchSummary(query)
      .then((summary) => {
        if (cancelled) return
        setState({ status: 'ready', summary })
        // While every model is shown, keep the option list from collapsing
        // to the filtered selection.
        if (filters.model === '') setModels(summary.byModel.map(row => row.model))
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => { cancelled = true }
  }, [filters, attempt])

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

  const { total } = state.summary
  const view = currencyViewOf(state.summary)
  return (
    <div ref={rootRef} className={styles['section']}>
      <h2 className={styles['title']}>{t('nav.label')}</h2>
      <p className={styles['muted']}>{t('dataDir', { path: state.summary.dataDir })}</p>
      <FilterBar filters={filters} models={models} onChange={setFilters} t={t} />
      {total.requests === 0
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
              <StatCard label={t('stat.requests')} value={total.requests.toLocaleString()} />
              <StatCard label={t('stat.cost')} value={formatCost(state.summary.totalCost, view)} accent />
              <StatCard label={t('stat.totalTokens')} value={formatTokens(totalTokens(total))} />
              <StatCard label={t('stat.hitRate')} value={formatHitRate(total)} />
            </div>
            <div className={styles['cards']}>
              <StatCard label={t('stat.input')} value={formatTokens(total.inputTokens)} />
              <StatCard label={t('stat.output')} value={formatTokens(total.outputTokens)} />
              <StatCard label={t('stat.cacheRead')} value={formatTokens(total.cacheReadTokens)} />
              <StatCard label={t('stat.cacheWrite')} value={formatTokens(total.cacheWriteTokens)} />
            </div>
            {state.summary.unpricedModels.length > 0
              ? (
                <p className={styles['warning']} role="status">
                  {t('unpriced.warning', {
                    count: String(state.summary.unpricedModels.length),
                    models: state.summary.unpricedModels.join(', '),
                    zero: formatCost(0, view),
                  })}
                </p>
              )
              : null}
            <TrendChart
              rows={state.summary.byDay}
              t={t}
              {...filters.from !== '' ? { from: filters.from } : {}}
              {...filters.to !== '' ? { to: filters.to } : {}}
              // A single-day window (the 1d quick range or a same-day custom
              // selection) plots the day's 24 hours instead of one point.
              {...filters.from !== '' && filters.from === filters.to ? { hours: state.summary.byHour } : {}}
            />
            {state.summary.byModel.length > 0
              ? (
                <>
                  <h3 className={styles['subtitle']}>{t('byModel.title')}</h3>
                  <div className={styles['tableWrap']}>
                    <table className={styles['table']} aria-label={t('byModel.title')}>
                      <thead>
                        <tr>
                          <th className={styles['modelHead']}>{t('filter.model')}</th>
                          <th>{t('stat.requests')}</th>
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
                        {state.summary.byModel.map(row => {
                          const rules = state.summary.pricing[row.model]
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
                              <td>{row.totals.requests.toLocaleString()}</td>
                              <td className={rules !== undefined ? styles['costCell'] : undefined}>
                                {rules !== undefined ? formatCost(row.cost, view) : '—'}
                              </td>
                              <td>{formatTokens(totalTokens(row.totals))}</td>
                              <td>{formatTokens(row.totals.inputTokens)}</td>
                              <td>{formatTokens(row.totals.outputTokens)}</td>
                              <td>{formatTokens(row.totals.cacheReadTokens)}</td>
                              <td>{formatTokens(row.totals.cacheWriteTokens)}</td>
                              <td>{formatHitRate(row.totals)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )
              : null}
            {detailModel !== null && state.summary.pricing[detailModel] !== undefined
              ? (
                <PricingDialog
                  model={detailModel}
                  rules={state.summary.pricing[detailModel]!}
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
