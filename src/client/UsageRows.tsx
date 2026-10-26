/**
 * The dashboards' flat row lists (browser half): one component, three
 * shapes — `project` (directory-tail folds), `model` (the priced rows) and
 * `session` (two-line rows). All three read the same single-line grammar
 * of the v3 demo: name | relative bar (projects/models only) | total
 * tokens · cache share | cost; sessions swap the bar for a second identity
 * line (directory · activity) under the same figures cells, all three
 * lists rendering one figures style everywhere (no hover affordance — a
 * former four-bucket popup read as clutter and went).
 *
 * The relative bar scales to
 * the active sort's own measure — tokens while sorted by tokens, billed cost
 * while sorted by cost — so the bars never contradict the order they sit
 * in. Rows arrive FINAL from the host route (folded, sorted, truncated);
 * this component only re-organizes presentation. The Ctrl affordances move
 * with the rows: Ctrl+click on a listed session opens it (dashed
 * underline), Ctrl+click on a model toggles the section's model filter to
 * just that model.
 *
 * @module token-usage/client/UsageRows
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CostState, CostedModelRow, ModelPerf, PricingTable, SessionUsageRow, UsageTotals } from '../wire.ts'
import { MIN_PERF_SAMPLES } from '../wire.ts'
import { costsAvailable } from './PricingStatus.tsx'
import { dayKeyOf, totalTokens } from './day.ts'
import type { CurrencyView } from './format.ts'
import { formatCost, formatSpeed, formatTokens, formatTtft, hitRateDisplay } from './format.ts'
import { ModelAssociationBadge, UnpricedModelTag } from './PricingAssociations.tsx'
import type { ProjectUsageRow } from './project-rows.ts'
import { dirTailOf } from './project-rows.ts'
import styles from './UsageRows.module.css'

/** Which row shape the list renders. */
export type UsageRowsKind = 'project' | 'model' | 'session'

/** The row lists' controlled sort. `tokens` on projects passes the fold's
 * native order through; `cost` on sessions passes the served order
 * through; models re-sort under both picks (they arrive request-count
 * descending), ties broken by name. Sorting never carries the performance
 * view — that is a content switch ({@link UsageRowsProps.perfView}), not
 * a third pick. */
export type RowSort = 'tokens' | 'cost' | 'recent'

/** The label of one sort pick. */
function sortLabelOf(sort: RowSort, t: TranslateNS<'token-usage'>): string {
  return sort === 'tokens' ? t('sort.tokens') : sort === 'cost' ? t('stat.cost') : t('session.lastActive')
}

/** Sort toggle rendered in a card head / above a tab's list. Controlled —
 * the section owns the state, so the page and the panel keep independent
 * picks. */
export function RowSortControl({ value, options, onChange, ariaLabel, t, compact = false }: {
  value: RowSort
  options: readonly RowSort[]
  onChange: (next: RowSort) => void
  ariaLabel: string
  t: TranslateNS<'token-usage'>
  compact?: boolean
}): ReactNode {
  return (
    <div className={compact ? `${styles['segmented']} ${styles['controlCompact']}` : styles['segmented']} role="group" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option}
          type="button"
          className={value === option ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {sortLabelOf(option, t)}
        </button>
      ))}
    </div>
  )
}

/** The performance view toggle (model card head): a view switch, not a
 * third sort pick — pressed, the card shows the speed rows and the sort
 * control yields (the performance order is its own definition: ranked
 * rows by mean speed, the dimmed ones sunk; there is no second way to
 * order them). */
export function PerfToggle({ pressed, onToggle, t, compact = false }: {
  pressed: boolean
  onToggle: (next: boolean) => void
  t: TranslateNS<'token-usage'>
  compact?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      className={[styles['perfToggle'], pressed ? styles['perfOn'] : '', compact ? styles['perfCompact'] : ''].filter(Boolean).join(' ')}
      aria-pressed={pressed}
      aria-label={t('perf.toggle')}
      onClick={() => onToggle(!pressed)}
    >
      <span className={styles['perfGauge']} aria-hidden={true}>◷</span>
      {t('perf.toggle')}
    </button>
  )
}

/** Whether Ctrl (or ⌘) is held right now: the jump affordances exist only
 * while it is, so plain clicks keep the rows inert. `blur` resets — a focus
 * loss can swallow the keyup and strand the state on. */
function useCtrlHeld(): boolean {
  const [ctrlHeld, setCtrlHeld] = useState(false)
  useEffect(() => {
    const down = (event: KeyboardEvent): void => { if (event.key === 'Control' || event.key === 'Meta') setCtrlHeld(true) }
    const up = (event: KeyboardEvent): void => { if (event.key === 'Control' || event.key === 'Meta') setCtrlHeld(false) }
    const move = (event: MouseEvent): void => {
      const active = event.ctrlKey || event.metaKey
      setCtrlHeld(previous => (previous === active ? previous : active))
    }
    const blur = (): void => setCtrlHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('mousemove', move)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return ctrlHeld
}

/** A short session-id fallback: the leading chunk is usually enough to
 * tell sessions apart when no title ever landed. */
function shortIdOf(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

/** Relative last-active label (「3 小时前」): minutes inside the first hour,
 * hours inside the first day, days beyond. */
function relativeTimeOf(time: number, t: TranslateNS<'token-usage'>): string {
  const minutes = Math.max(1, Math.floor((Date.now() - time) / 60_000))
  if (minutes < 60) return t('time.minutesAgo', { count: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: String(hours) })
  return t('time.daysAgo', { count: String(Math.floor(hours / 24)) })
}

/** Props for the flat row list. Only the array matching `kind` is read;
 * the optional seats (session jump, model filter, price dialog) are absent
 * on tests and hosts without them, and the rows then render inert. */
export interface UsageRowsProps {
  kind: UsageRowsKind
  /** `kind: 'project'` — the directory-tail folds. */
  projectRows?: readonly ProjectUsageRow[] | undefined
  /** `kind: 'model'` — the priced per-model rows. */
  modelRows?: readonly CostedModelRow[] | undefined
  /** `kind: 'session'` — the served per-session rows (final order = cost). */
  sessionRows?: readonly SessionUsageRow[] | undefined
  /** The controlled sort pick (see {@link RowSort}); the default depends
   * on the kind — `tokens` on project/model, `cost` on session. Ignored
   * while `perfView` is set. */
  sort?: RowSort | undefined
  /** Model rows only: the performance view is up — the figures cells read
   * the speed means, the order is speed-fixed (ranked rows first, the
   * dimmed ones sunk), and the sort pick yields until toggled off. */
  perfView?: boolean | undefined
  /** The pricing table: which models are priced (name is the price
   * affordance) and the rates a model row's cost splits against. */
  pricing?: PricingTable | undefined
  /** The cost layer's state; not `ready`, every cost cell reads `—`. */
  costState?: CostState | undefined
  /** Currency display view (symbol + rate). */
  view: CurrencyView
  /** Locale function. */
  t: TranslateNS<'token-usage'>
  /** Session jump seats: whether the controller lists a session, and the
   * open callback (the parent closes its panel on success). */
  sessionListed?: ((id: string) => boolean) | undefined
  onSessionOpen?: ((id: string) => void) | undefined
  /** Ctrl+click on a model row: toggle the section's model filter. */
  onToggleModel?: ((model: string) => void) | undefined
  /** Plain click on a priced model's name: open the price dialog. */
  onModelName?: ((model: string) => void) | undefined
}

/**
 * Render one flat row list. The list is the height-capped scroll container
 * (scrollbar appears while scrolling, fades 800ms after it stops).
 */
export function UsageRows({
  kind,
  projectRows,
  modelRows,
  sessionRows,
  sort,
  perfView,
  pricing,
  costState,
  view,
  t,
  sessionListed,
  onSessionOpen,
  onToggleModel,
  onModelName,
}: UsageRowsProps): ReactNode {
  const ctrlHeld = useCtrlHeld()
  // Scrollbar fade: add the class on scroll, drop it 800ms after the last
  // event; the timer dies with the component.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(scrollTimer.current), [])
  const handleScroll = (): void => {
    const box = scrollRef.current
    const cls = styles['scrolling']
    if (box === null || cls === undefined) return
    box.classList.add(cls)
    window.clearTimeout(scrollTimer.current)
    scrollTimer.current = window.setTimeout(() => {
      box.classList.remove(cls)
    }, 800)
  }

  // The rendered set for this kind under the active pick. Straight-through
  // where the native order already matches (projects ship tokens-desc,
  // sessions cost-desc); models always re-sort (they arrive request-count
  // descending), ties broken by name for a stable order. The performance
  // view replaces the pick entirely — its order is speed-fixed.
  const perfMode = perfView === true && kind === 'model'
  const active = sort ?? (kind === 'session' ? 'cost' : 'tokens')
  const rows = useMemo<readonly (ProjectUsageRow | CostedModelRow | SessionUsageRow)[]>(() => {
    const base = kind === 'project' ? projectRows : kind === 'model' ? modelRows : sessionRows
    if (base === undefined) return []
    if (kind === 'session') {
      if (active === 'cost') return base
      const sessions = [...base] as SessionUsageRow[]
      return sessions.sort(active === 'recent'
        ? (left, right) => right.lastTime - left.lastTime || (left.sessionId < right.sessionId ? -1 : 1)
        : (left, right) => totalTokens(right.totals) - totalTokens(left.totals) || (left.sessionId < right.sessionId ? -1 : 1))
    }
    if (kind === 'project') {
      if (active === 'tokens') return base
      return [...(base as readonly ProjectUsageRow[])].sort((left, right) => right.cost - left.cost || (left.name < right.name ? -1 : 1))
    }
    const models = [...base] as CostedModelRow[]
    if (perfMode) {
      // Speed ranking over the streaming samples. A row without enough
      // samples (or any timing) cannot rank honestly, so it sinks below
      // the ranked ones, name-ordered — the same rows drop their bar.
      const ranked = (row: CostedModelRow): boolean =>
        row.perf !== undefined && row.perf.samples >= MIN_PERF_SAMPLES
      return models.sort((left, right) => {
        const leftRanked = ranked(left)
        const rightRanked = ranked(right)
        if (leftRanked !== rightRanked) return leftRanked ? -1 : 1
        if (leftRanked && rightRanked) {
          return right.perf!.tokensPerSec - left.perf!.tokensPerSec || (left.model < right.model ? -1 : 1)
        }
        return left.model < right.model ? -1 : 1
      })
    }
    return models.sort(active === 'tokens'
      ? (left, right) => totalTokens(right.totals) - totalTokens(left.totals) || (left.model < right.model ? -1 : 1)
      : (left, right) => right.cost - left.cost || (left.model < right.model ? -1 : 1))
  }, [kind, projectRows, modelRows, sessionRows, active, perfMode])

  // The bar scale: the tallest row of the *rendered* set is 100%,
  // measured in the active unit — a cost-sorted list bars by cost, the
  // performance view by mean speed (ranked rows only: the dimmed
  // low-sample rows drop their bar and must not stretch the scale), or
  // the bars would contradict the order they sit in. Zero renders
  // zero-width bars (never NaN).
  const barValueOf = (row: ProjectUsageRow | CostedModelRow | SessionUsageRow): number =>
    perfMode ? ('perf' in row && row.perf !== undefined && row.perf.samples >= MIN_PERF_SAMPLES ? row.perf.tokensPerSec : 0)
      : active === 'cost' ? row.cost
        : totalTokens(row.totals)
  const barMax = useMemo(() => {
    let max = 0
    for (const row of rows) {
      const value = barValueOf(row)
      if (value > max) max = value
    }
    return max
  }, [rows, active])

  const costText = (cost: number): string =>
    costsAvailable(costState) ? formatCost(cost, view) : '—'

  /** The figures cell: total tokens · cache share, right-aligned in its
   * fixed column. No hover affordance — the user read the popup as
   * clutter on every list, so the cell is plain. */
  const numsCell = (totals: UsageTotals): ReactNode => {
    const hit = hitRateDisplay(totals)
    return (
      <span className={styles['rowNums']}>
        {formatTokens(totalTokens(totals))}
        {' · '}
        {t('stat.cacheRead')}
        {' '}
        {hit.text}
      </span>
    )
  }

  /** The performance figures cell: mean speed (bold) · first token · mean
   * request latency · timed request count over one compact line, the grammar
   * every figures cell reads. Below the streaming-sample threshold the
   * cell dims to speed + 「样本不足」, and no timing at all renders its
   * own dim label. Untimed requests never count as performance samples.
   * No hover affordance. */
  const perfCell = (perf: ModelPerf | undefined): ReactNode => {
    const count = t('perf.requestCount', { count: String(perf?.timedRequests ?? 0) })
    if (perf === undefined) {
      return <span className={`${styles['perfNums']} ${styles['perfDim']}`}>{t('perf.noTiming')} · {count}</span>
    }
    const speed = `${formatSpeed(perf.tokensPerSec)} tok/s`
    if (perf.samples < MIN_PERF_SAMPLES) {
      return (
        <span className={`${styles['perfNums']} ${styles['perfDim']}`}>
          <b>{speed}</b>
          {' · '}
          {t('perf.lowSamples')}
          {' · '}
          {count}
        </span>
      )
    }
    return (
      <span className={styles['perfNums']}>
        <b>{speed}</b>
        {' · '}
        {t('perf.first')}
        {' '}
        {formatTtft(perf.firstTokenMs)}
        {' · '}
        {t('perf.avgLatency')}
        {' '}
        {formatTtft(perf.latencyMs)}
        {' · '}
        {count}
      </span>
    )
  }

  const ariaLabel = kind === 'project' ? t('byProject.title') : kind === 'model' ? t('byModel.title') : t('bySession.title')

  return (
    <div className={styles['rows']} ref={scrollRef} onScroll={handleScroll} role="list" aria-label={ariaLabel}>
        {rows.length === 0
          ? <div className={styles['empty']}>{t('chart.empty')}</div>
          : rows.map(row => {
            if (kind === 'project') {
              const project = row as ProjectUsageRow
              return (
                <div className={styles['row']} role="listitem" key={project.name === '' ? '\u0000' : project.name}>
                  <span className={styles['rowName']} title={project.cwd ?? project.name}>
                    {project.name === '' ? t('session.untitledDir') : project.name}
                  </span>
                  <span className={styles['track']}>
                    {barMax > 0
                      ? (
                        <span
                          className={styles['fill']}
                          style={{ width: `${(barValueOf(project) / barMax) * 100}%` }}
                        />
                      )
                      : null}
                  </span>
                  {numsCell(project.totals)}
                  <span className={styles['rowCost']}>{costText(project.cost)}</span>
                </div>
              )
            }
            if (kind === 'model') {
              const model = row as CostedModelRow
              const rules = pricing?.[model.model]
              const filterJump = ctrlHeld && onToggleModel !== undefined
              // Under the performance view a row that cannot rank honestly
              // (too few streaming samples, or no timing) drops its bar and
              // lets the name take the width.
              const perfRanked = model.perf !== undefined && model.perf.samples >= MIN_PERF_SAMPLES
              return (
                <div className={styles['row']} role="listitem" key={model.model}>
                  <span className={perfMode && !perfRanked ? `${styles['rowName']} ${styles['nameGrow']}` : styles['rowName']}>
                    <span className={styles['nameLine']}>
                      {rules !== undefined
                        ? (
                          // Same affordance as the per-model table: the
                          // name opens the price dialog — unless Ctrl is
                          // held, when it toggles the model filter instead.
                          <button
                            type="button"
                            className={filterJump ? `${styles['nameText']} ${styles['jumpable']}` : styles['nameText']}
                            title={filterJump ? t('model.ctrlHint') : undefined}
                            aria-label={filterJump ? t('model.ctrlHint') : t('pricing.view', { model: model.model })}
                            onClick={filterJump
                              ? event => {
                                event.preventDefault()
                                onToggleModel?.(model.model)
                              }
                              : () => onModelName?.(model.model)}
                          >
                            {model.model}
                          </button>
                        )
                        : <span className={styles['nameText']}>{model.model}</span>}
                      {rules !== undefined ? null : <UnpricedModelTag model={model.model} t={t} />}
                      <ModelAssociationBadge model={model.model} t={t} />
                    </span>
                  </span>
                  {perfMode
                    ? (perfRanked
                      ? (
                        <span className={styles['track']}>
                          {barMax > 0
                            ? (
                              <span
                                className={styles['fill']}
                                style={{ width: `${(barValueOf(model) / barMax) * 100}%` }}
                              />
                            )
                            : null}
                        </span>
                      )
                      : null)
                    : (
                      <span className={styles['track']}>
                        {barMax > 0
                          ? (
                            <span
                              className={styles['fill']}
                              style={{ width: `${(barValueOf(model) / barMax) * 100}%` }}
                            />
                          )
                          : null}
                      </span>
                    )}
                  {/* The performance view swaps the figures cell for the
                   * speed means and drops the cost column — the row ends at
                   * its figures, the same shape the demo pinned. */}
                  {perfMode ? perfCell(model.perf) : numsCell(model.totals)}
                  {perfMode
                    ? null
                    : <span className={styles['rowCost']}>{rules !== undefined ? costText(model.cost) : '—'}</span>}
                </div>
              )
            }
            const session = row as SessionUsageRow
            // A session row is jumpable when the controller lists it; the
            // click re-checks through onSessionOpen (the list may have moved
            // between hover and click).
            const jump = ctrlHeld && sessionListed !== undefined && onSessionOpen !== undefined && sessionListed(session.sessionId)
            return (
              <div className={`${styles['row']} ${styles['srow']}`} role="listitem" key={session.sessionId}>
                {/* The top line reads like every other row: name | total
                 * tokens · cache share | cost (the same figures cell, same
                 * hover tooltip — no cost row, no model mix to apportion
                 * against). The second line keeps directory · activity. */}
                <div className={styles['rowTop']}>
                  <span className={styles['rowName']}>
                    <span className={styles['nameLine']}>
                      <button
                        type="button"
                        className={jump ? `${styles['nameText']} ${styles['jumpable']}` : styles['nameText']}
                        title={jump ? t('session.openHint') : undefined}
                        onClick={jump || (ctrlHeld && onSessionOpen !== undefined)
                          ? event => {
                            event.preventDefault()
                            onSessionOpen?.(session.sessionId)
                          }
                          : undefined}
                      >
                        {session.title !== undefined
                          ? session.title
                          : `${shortIdOf(session.sessionId)} · ${dayKeyOf(new Date(session.firstTime))} – ${dayKeyOf(new Date(session.lastTime))}`}
                      </button>
                      {session.childCount !== undefined && session.childCount > 0
                        ? (
                          <span
                            className={styles['badge']}
                            aria-label={t('view.subagents.nested', { count: String(session.childCount) })}
                          >
                            {t('view.subagents.nested', { count: String(session.childCount) })}
                          </span>
                        )
                        : null}
                    </span>
                  </span>
                  {numsCell(session.totals)}
                  <span className={styles['rowCost']}>{costText(session.cost)}</span>
                </div>
                <div className={styles['rowSub']}>
                  {session.cwd === undefined ? t('session.untitledDir') : dirTailOf(session.cwd)}
                  {' · '}
                  {relativeTimeOf(session.lastTime, t)}
                </div>
              </div>
            )
          })}
      </div>
  )
}
