/**
 * Shared "stat card" primitive: label on top, value underneath. Used by the
 * settings section (primary cards + four token-bucket cards) and the Usage
 * view tab (six cards: requests-with-failure-pill / cost / total tokens /
 * hit rate / TTFT / token speed). Centralising the markup + styling means
 * the two surfaces read as one family without each one carrying its own
 * copy of the label-on-top / value-below rule.
 *
 * {@link FailurePill} is the compact failed-count chip the requests card
 * uses; {@link OverheadPill} is its neutral sibling for the recorded
 * auxiliary-request count, wired to jump to the runtime-overhead section.
 * Per-model tables use {@link RequestsCell} (`A/B`, B in the error
 * color) instead — a pill is too much chrome for a numeric column.
 *
 * @module token-usage/client/StatCard
 */

import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageAuxKindRow } from '../wire.ts'
import { failuresTooltip, overheadTooltip } from './format.ts'
import styles from './StatCard.module.css'

/** One labelled figure inside a card. */
export interface StatCardProps {
  /** The small secondary line ("token cost", "hit rate", "总 token"). */
  label: string
  /** The bold tabular-numeric value (`1.5M`, `¥12.34`, `0.5s`). A
   * node is accepted so the hit-rate card can wrap {@link HitRateText}
   * and inherit the four-bucket colour without a second card variant. */
  value: ReactNode
  /** Settings uses `'sm'` for a fixed four-by-two overview (16px figures).
   * The wide-column variant (`'lg'`): the v3 demo's figures — 20px
   * value over a 12px label in a roomier tile. The page's nine-track
   * row renders it; the Usage view keeps the default figures. */
  size?: 'sm' | 'lg' | undefined
  /** A node riding beside the label (not below it): the compact lead
   * card's overhead pill. The narrow tile would wrap a pill on the
   * value line and stretch the whole grid row; up here it fits. */
  labelExtra?: ReactNode | undefined
}

/**
 * Render one stat card. The value uses the standard label-primary color.
 * The label clamps to one line and ellipsizes if the column is squeezed.
 */
export function StatCard({ label, value, size, labelExtra }: StatCardProps): ReactNode {
  const card = size === 'lg' ? `${styles['card']} ${styles['cardLg']}`
    : size === 'sm' ? `${styles['card']} ${styles['cardSm']}` : styles['card']
  return (
    <div className={card}>
      {labelExtra === undefined
        ? <span className={styles['cardLabel']}>{label}</span>
        : (
          <span className={styles['cardLabelRow']}>
            <span className={styles['cardLabel']}>{label}</span>
            {labelExtra}
          </span>
        )}
      <span className={styles['cardValue']}>{value}</span>
    </div>
  )
}

/** Props for the shared failure-count pill. */
export interface FailurePillProps {
  /** Failed provider attempts; 0 renders nothing. */
  failures: number
  /** Per-code breakdown driving the tooltip. */
  failuresByCode: Record<string, number> | undefined
  /** Locale function (`stat.failuresPill` / `fail.*`). */
  t: TranslateNS<'token-usage'>
  /** Render as bare red text instead of the capsule: the compact lead
   * card's value line fits a six-digit count plus the breakdown only
   * without the pill chrome — a capsule there wraps to a third line and
   * stretches the whole grid row. Same tooltip and keyboard focus. */
  bare?: boolean | undefined
}

/**
 * Compact "失败 n" chip for the requests **card** only. Hovering or focusing
 * it lists `限流 ×count` per class. Zero failures render nothing. Per-model
 * tables do not use this — they print `A/B` via {@link RequestsCell}.
 */
export function FailurePill({
  failures,
  failuresByCode,
  t,
  bare = false,
}: FailurePillProps): ReactNode {
  if (failures === 0) return null
  return (
    <span className={styles['pillWrap']}>
      <Tooltip
        label={failuresTooltip(failuresByCode, t)}
        side="bottom"
        delayMs={200}
      >
        {bare
          ? (
              <span
                className={styles['failBare']}
                tabIndex={0}
                aria-label={t('stat.failuresPill', { count: failures.toLocaleString() })}
              >
                {t('stat.failuresPill', { count: failures.toLocaleString() })}
              </span>
            )
          : (
              <span className={styles['pill']} tabIndex={0}>
                {t('stat.failuresPill', { count: failures.toLocaleString() })}
              </span>
            )}
      </Tooltip>
    </span>
  )
}

/** Props for the shared successful-requests card with a failure pill. */
export interface RequestsStatCardProps {
  /** Successful (billed) request count. */
  requests: number
  /** Failed provider attempts. */
  failures: number
  /** Per-code breakdown driving the pill tooltip. */
  failuresByCode: Record<string, number> | undefined
  /** Locale function (zh/en `stat.requests` / `stat.failuresPill`). */
  t: TranslateNS<'token-usage'>
  /** Recorded auxiliary request count; > 0 shows the neutral pill. */
  overheadRequests?: number | undefined
  /** Per-kind split driving the overhead pill's tooltip. */
  overheadByKind?: readonly UsageAuxKindRow[] | undefined
  /** Click on the overhead pill: the dashboards scroll to / switch to the
   * runtime-overhead section. Omitted hosts keep the pill inert. */
  onOverheadActivate?: (() => void) | undefined
  /** Stat-card pass-throughs: the page's `'lg'` figures, and a node on
   * the label row (the compact lead card parks the overhead pill there —
   * on the value line it would wrap and stretch the grid row). */
  size?: 'sm' | 'lg' | undefined
  labelExtra?: ReactNode | undefined
  /** Bare-text failure count (no capsule): the compact lead card's value
   * line — a six-digit count plus a capsule overruns the narrow tile. */
  failureBare?: boolean | undefined
}

/**
 * The requests tile both dashboards share: hero figure is the successful
 * count; a compact pill to its right carries the failure count, and — when
 * auxiliary requests were recorded — a neutral pill carries the runtime-
 * overhead count (hover for the per-kind split, click to jump there).
 */
export function RequestsStatCard({
  requests,
  failures,
  failuresByCode,
  t,
  overheadRequests,
  overheadByKind,
  onOverheadActivate,
  size,
  labelExtra,
  failureBare = false,
}: RequestsStatCardProps): ReactNode {
  return (
    <StatCard
      label={t('stat.requests')}
      size={size}
      labelExtra={labelExtra}
      value={(
        <>
          <span className={styles['cardValueMain']}>{requests.toLocaleString()}</span>
          <FailurePill failures={failures} failuresByCode={failuresByCode} t={t} {...(failureBare ? { bare: true } : {})} />
          <OverheadPill
            requests={overheadRequests}
            byKind={overheadByKind}
            onActivate={onOverheadActivate}
            t={t}
          />
        </>
      )}
    />
  )
}

/** Props for the shared overhead pill: a neutral count chip that lists the
 * per-kind split on hover and activates the overhead section on click. */
export interface OverheadPillProps {
  /** Recorded auxiliary request count; 0 or undefined renders nothing. */
  requests: number | undefined
  /** Per-kind breakdown driving the tooltip. */
  byKind: readonly UsageAuxKindRow[] | undefined
  /** Click callback (scroll-to on the page, tab-switch on the panel). */
  onActivate?: (() => void) | undefined
  /** Locale function (`stat.overheadPill` / `aux.kind.*`). */
  t: TranslateNS<'token-usage'>
}

/**
 * Compact "开销 n" chip beside the hero request count. Mirrors
 * {@link FailurePill} in neutral ink and is a real button — the dashboards
 * wire it to scroll-to (page) or switch-to (panel) the runtime-overhead
 * section. Zero recorded overhead renders nothing.
 */
export function OverheadPill({
  requests,
  byKind,
  onActivate,
  t,
}: OverheadPillProps): ReactNode {
  if (requests === undefined || requests === 0) return null
  return (
    <span className={styles['pillWrap']}>
      <Tooltip
        label={overheadTooltip(byKind, t)}
        side="bottom"
        delayMs={200}
      >
        <button
          type="button"
          className={styles['pillNeutral']}
          onClick={onActivate}
        >
          {t('stat.overheadPill', { count: requests.toLocaleString() })}
        </button>
      </Tooltip>
    </span>
  )
}

/** Props for the per-model requests cell: `success/fail` as `A/B`.
 * Tables pass the row's own totals so a session-scoped or date-filtered
 * summary cannot leak another row's failures into this cell. */
export interface RequestsCellProps {
  requests: number
  failures: number
  failuresByCode: Record<string, number> | undefined
  t: TranslateNS<'token-usage'>
}

/** Column header for the per-model success/fail split: same 3-track
 * grid as {@link RequestsCell} so the slash sits on the column midline. */
export function RequestsSplitHead({ t }: { t: TranslateNS<'token-usage'> }): ReactNode {
  return (
    <span className={styles['split']}>
      <span className={styles['splitOk']}>{t('stat.ok')}</span>
      <span className={styles['splitSep']} aria-hidden>/</span>
      <span className={styles['splitFailHead']}>{t('stat.fail')}</span>
    </span>
  )
}

/** One table cell: successful count, and when failures > 0 a slash on
 * the column midline plus the failure count in the error color.
 * Zero failures print only A (same left track, so the figure still
 * lines up with rows that have a B). Hovering B lists the per-code
 * breakdown. */
export function RequestsCell({
  requests,
  failures,
  failuresByCode,
  t,
}: RequestsCellProps): ReactNode {
  const ok = requests.toLocaleString()
  const okFigure = <span className={styles['splitOk']}>{ok}</span>
  if (failures === 0) {
    return <span className={styles['split']}>{okFigure}</span>
  }
  const fail = failures.toLocaleString()
  return (
    <span className={styles['split']}>
      {okFigure}
      <span className={styles['splitSep']} aria-hidden>/</span>
      <span className={styles['pillWrap']}>
        <Tooltip
          label={failuresTooltip(failuresByCode, t)}
          side="bottom"
          delayMs={200}
        >
          <span
            className={styles['splitFail']}
            tabIndex={0}
            aria-label={t('stat.failuresPill', { count: fail })}
          >
            {fail}
          </span>
        </Tooltip>
      </span>
    </span>
  )
}
