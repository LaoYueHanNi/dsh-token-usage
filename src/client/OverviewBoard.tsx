/**
 * The dashboards' shared overview board (browser half): the metric cards
 * (the composite first card「请求数 · 运行开销」spanning two grid
 * tracks, then cost / total / hit rate and the four buckets), the pricing
 * status line, and the trend card — titled 趋势, plotting the day's 24
 * hours on a single-day window (fixed; no plot pick) and the daily rows
 * on any wider window. Both the main page and the settings panel render
 * this same board, so the two surfaces read as one.
 *
 * @module token-usage/client/OverviewBoard
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssociationStorageError, AuxSummary, CostState, PricingUnavailableReason, UsageDayRow, UsageHourRow, UsageTotals } from '../wire.ts'
import { costsAvailable } from './PricingStatus.tsx'
import { PricingStatus } from './PricingStatus.tsx'
import { StatCard, RequestsStatCard, OverheadPill } from './StatCard.tsx'
import { TrendChart } from './TrendChart.tsx'
import { HitRateText } from './HitRateText.tsx'
import type { CurrencyView } from './format.ts'
import { formatCost, formatTokens } from './format.ts'
import { totalTokens } from './day.ts'
import styles from './OverviewBoard.module.css'

/** Props for the overview board — every field is derived data the section
 * (which owns the fetch and the filter state) passes down; the board never
 * requests. */
export interface OverviewBoardProps {
  /** The window's totals (the top-line aggregate). */
  total: UsageTotals
  /** Billed cost (¥) of the window; dashed when the cost layer is out. */
  totalCost: number
  costState: CostState
  pricingUnavailableReason?: PricingUnavailableReason | undefined
  associationStorageError?: AssociationStorageError | undefined
  /** The auxiliary layer driving the composite card's overhead pill
   * (absent / zero renders no pill). */
  aux?: AuxSummary | undefined
  /** The trend's daily points (always present). */
  byDay: readonly UsageDayRow[]
  /** The trend's hourly points (a single-day window only). */
  byHour: readonly UsageHourRow[]
  /** The active window bounds ('' = whole range). A single-day selection
   * (from === to, both non-empty) offers the hourly toggle. */
  from: string
  to: string
  /** Overhead pill click: scroll to / switch to the overhead section. */
  onOverheadActivate: () => void
  /** The settings panel's narrow body: the metric cards fall back to the
   * section's old two-rows-of-four layout (the composite card keeps its
   * pills but reads the short label), while the page's wide column keeps
   * the demo's single nine-track row. */
  compact?: boolean | undefined
  /** Currency display view (symbol + rate). */
  view: CurrencyView
  t: TranslateNS<'token-usage'>
}

/**
 * Render the overview board: one metric row (the composite lead card
 * spans two tracks), the pricing status, and the trend card.
 */
export function OverviewBoard({
  total,
  totalCost,
  costState,
  pricingUnavailableReason,
  associationStorageError,
  aux,
  byDay,
  byHour,
  from,
  to,
  onOverheadActivate,
  compact = false,
  view,
  t,
}: OverviewBoardProps): ReactNode {
  // A single-day window plots the day's 24 hours (the section's old
  // semantics, fixed — no plot pick); any other window plots the daily rows.
  const singleDay = from !== '' && from === to
  // The page's wide column renders the demo's 20px figures; the panel's
  // narrow grid keeps the compact ones.
  const cardSize = compact ? ('sm' as const) : ('lg' as const)
  return (
    <div className={styles['board']}>
      <div className={compact ? styles['metricGridCompact'] : styles['metricGrid']}>
        {/* display: contents — the composite card itself becomes the grid
         * item (spanning two tracks on the page's wide row), so its tile
         * keeps the family chrome. The pill seats differ: the page's wide
         * lead card parks both pills on the value line; the panel's narrow
         * one would wrap them there and stretch the whole row, so its
         * overhead pill rides the label row instead. */}
        <div className={compact ? styles['leadSpanCompact'] : styles['leadSpan']}>
          <RequestsStatCard
            requests={total.requests}
            failures={total.failures ?? 0}
            failuresByCode={total.failuresByCode}
            {...(compact
              ? {
                  labelExtra: (
                    <OverheadPill
                      requests={aux?.total.requests}
                      byKind={aux?.byKind}
                      onActivate={onOverheadActivate}
                      t={t}
                    />
                  ),
                  // The narrow tile fits the count plus the failure
                  // breakdown only as bare text — a capsule wraps to a
                  // third line and stretches the whole grid row.
                  failureBare: true,
                }
              : {
                  overheadRequests: aux?.total.requests,
                  overheadByKind: aux?.byKind,
                  onOverheadActivate,
                })}
            size={cardSize}
            t={t}
          />
        </div>
        <StatCard size={cardSize} label={t('stat.cost')} value={costsAvailable(costState) ? formatCost(totalCost, view) : '—'} />
        <StatCard size={cardSize} label={t('stat.totalTokens')} value={formatTokens(totalTokens(total))} />
        <StatCard size={cardSize} label={t('stat.hitRate')} value={<HitRateText totals={total} />} />
        <StatCard size={cardSize} label={t('stat.input')} value={formatTokens(total.inputTokens)} />
        <StatCard size={cardSize} label={t('stat.output')} value={formatTokens(total.outputTokens)} />
        <StatCard size={cardSize} label={t('stat.cacheRead')} value={formatTokens(total.cacheReadTokens)} />
        <StatCard size={cardSize} label={t('stat.cacheWrite')} value={formatTokens(total.cacheWriteTokens)} />
      </div>
      <PricingStatus costState={costState} pricingUnavailableReason={pricingUnavailableReason} associationStorageError={associationStorageError} t={t} />
      <div className={styles['trendCard']}>
        <span className={styles['trendTitle']}>{t('trend.title')}</span>
        <TrendChart
          rows={byDay}
          t={t}
          {...from !== '' ? { from } : {}}
          {...to !== '' ? { to } : {}}
          {...(singleDay ? { hours: byHour } : {})}
        />
      </div>
    </div>
  )
}
