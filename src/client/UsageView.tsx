/**
 * The conversation view tab "Usage" (browser half): one entry of the
 * `conversation.view` slot ring (beside Chat / Trajectory), rendering the
 * per-session token & cost dashboard for the ACTIVE conversation. The tab
 * shows the focused session's totals (successful requests with a failure
 * pill, 4 token buckets, cost, hit rate, TTFT average, decode throughput) with a
 * scope switch between the session alone and its whole subagent subtree, a
 * per-hour trend chart and the per-model table from the host stats route
 * (`root` + `scope` scoped), and a subagent table below — each row drill-in
 * switches the focus to that child.
 *
 * Data sources: token/cost figures come from the host route (the pricing
 * rule chain's authority). The header's TTFT and throughput come from the
 * framework's retained `sessionStats` projection (`useProjection`), which
 * covers history written before this plugin was installed; the SUBAGENT
 * table's two timing columns instead read `children[].timing`, folded by the
 * host from recorded requests (post-install, timed requests only). A
 * footnote states both scopes so the difference is not a surprise.
 *
 * The root declares `data-conversation-composer-overlay` — the same host
 * opt-in Trajectory uses. ConversationRoot hides the chat-column width
 * handles when that attribute is present, and the view owns its own
 * scroller instead of sharing the transcript's constrained column.
 *
 * @module token-usage/client/UsageView
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
// Type-only: merges the sessionStats key into SessionProjectionMap so
// useProjection('sessionStats') reads its real type.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { UsageSummary } from '../wire.ts'
import { encodeStatsQuery, STATS_PATH } from '../wire.ts'
import { useAsyncResource, useDebouncedValue } from './async-resource.ts'
import { totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatSpeed, formatTokens, formatTtft } from './format.ts'
import { PricingStatus, costsAvailable } from './PricingStatus.tsx'
import { ModelAssociationBadge, PricingAssociationProvider, UnpricedModelTag } from './PricingAssociations.tsx'
import { usePricingAssociationRefresh } from './pricing-associations.ts'
import { HitRateText } from './HitRateText.tsx'
import { RequestPoolSections } from './RequestPool.tsx'
import { aggregateProjections, buildChildIndex, directSubagentIds, subagentParentOf, subtreeIds, buildStatsFreshnessKey } from './session-stats.ts'
import { RequestsCell, RequestsStatCard, StatCard } from './StatCard.tsx'
import { TrendChart } from './TrendChart.tsx'
import type { TrendChartMode } from './TrendChart.tsx'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import styles from './UsageView.module.css'

/** The view's scope switch: the session alone, or its whole subagent subtree. */
export type UsageScope = 'session' | 'tree'

/** Refresh debounce: bursts of session-mirror updates (one request's events)
 * collapse into a single fetch, so the dashboard refreshes at REQUEST
 * granularity instead of per event or per turn. */
const REFRESH_DEBOUNCE_MS = 250

/** Host contract (ui-conversation ConversationRoot): views that own a
 * full-bleed scroller set this so the chat-column width handles hide and
 * the composer seat overlays instead of stealing clicks over the dashboard. */
const COMPOSER_OVERLAY = { 'data-conversation-composer-overlay': '' } as const

/** Props: the conversation-view runtime seat (standard kit) plus the locale
 * seat. The kit's `useSession` covers the Session lifecycle snapshot only;
 * the Conversation snapshot is not part of it — and this view never read it,
 * so the seat is simply dropped. */
export interface UsageViewProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useProjection: UseProjection
  sessionId: SessionId
  t: TranslateNS<'token-usage'>
}

/** One fetch of the session-scoped summary from the host stats route.
 * The request carries a RANGE RULE (root + scope), never the enumerated
 * subtree: the host expands it from its session-metadata lineage, so the URL
 * stays O(1) however many subagents the conversation has. */
function fetchSessionSummary(
  root: string,
  scope: UsageScope,
  signal: AbortSignal,
): Promise<UsageSummary> {
  return fetch(STATS_PATH + encodeStatsQuery({
    root,
    scope: scope === 'tree' ? 'subtree' : 'self',
    fields: 'session',
  }), { signal })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return response.json() as Promise<unknown>
    })
    .then(value => {
      if (typeof value !== 'object' || value === null || typeof (value as { total?: unknown }).total !== 'object') {
        throw new Error('unexpected stats response')
      }
      return value as UsageSummary
    })
}

/**
 * Render the Usage view tab for the active conversation.
 * @param props - the framework session kit, the session mirror, and the
 * locale seat (from the registration's `locale:` declaration).
 * @returns the dashboard: header (title, scope switch, back), stat cards
 * and the 4-token strip, the chart/model columns, and the subagent table.
 */
export function UsageView({ useSessions, useProjection, sessionId, t }: UsageViewProps): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null)
  useColorSchemeMirror(rootRef)
  const [scope, setScope] = useState<UsageScope>('session')
  // The trend chart's y-axis reading: per-interval totals or their running
  // cumulative sum. Session-local like the scope switch (no persistence).
  const [chartMode, setChartMode] = useState<TrendChartMode>('interval')
  // The dashboard focus: the active conversation until a subagent row is
  // drilled into. Reset when the conversation itself changes — the pane
  // may reuse this instance across session switches.
  const [focusId, setFocusId] = useState<SessionId>(sessionId)
  useEffect(() => { setFocusId(sessionId) }, [sessionId])
  const [retryToken, setRetryToken] = useState(0)
  const retry = (): void => { setRetryToken(token => token + 1) }
  usePricingAssociationRefresh(retry)
  // The subagent list's fade scrollbar: the list scrolls only once it has
  // the focus (see `.subagentsWrap:focus-within` in the stylesheet — a
  // plain hover must leave the page's wheel alone), and the thumb tints in
  // only while it is actually being scrolled, then fades back 800ms after
  // the last event (the request-pool history table's grammar). Direct
  // classList writes, no re-render.
  const subagentsRef = useRef<HTMLDivElement | null>(null)
  const subagentsTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(subagentsTimer.current), [])
  const handleSubagentsScroll = (): void => {
    const box = subagentsRef.current
    const cls = styles['scrolling']
    if (box === null || cls === undefined) return
    box.classList.add(cls)
    window.clearTimeout(subagentsTimer.current)
    subagentsTimer.current = window.setTimeout(() => {
      box.classList.remove(cls)
    }, 800)
  }

  const byId = useSessions(state => state.byId)
  // Build the child index once per mirror churn and share it across the
  // three tree helpers — directSubagentIds / subtreeIds / per-row nested
  // counts — so a heavy subagent subtree doesn't pay O(n) per call.
  const childIndex = useMemo(() => buildChildIndex(byId), [byId])
  // The scoped session ids: the focus alone, or the focus plus its subtree.
  const scopeIds = useMemo(
    () => scope === 'tree' ? subtreeIds(byId, focusId, childIndex) : [focusId],
    [byId, scope, focusId, childIndex],
  )
  const children = useMemo(() => directSubagentIds(byId, focusId, childIndex), [byId, focusId, childIndex])
  // The per-child breakdown is derived server-side from the same lineage;
  // the view only needs the child ids to render rows and drill in.
  const backParent = subagentParentOf(byId, focusId)
  // Live sessionStats updates every request step; mirror updatedAt alone
  // does not — fold both into the debounce key (same cadence as TTFT).
  const liveStats = useProjection('sessionStats')
  const scopedIds = [...new Set([...scopeIds, ...children])]
  // Identity of the id SET (not its per-id figures). A late mirror delivery
  // changes this; a real settled request only changes updatedAt / projection
  // fingerprints and must still trigger a refresh.
  const scopeIdsKey = scopedIds.join(',')
  const freshnessKey = buildStatsFreshnessKey(
    scopedIds,
    { activeSessionId: sessionId, rows: byId, liveSessionStats: liveStats },
  )
  // The debounce identity is root + scope + freshness, NOT the enumerated
  // subtree: scopeIds still drive TTFT aggregation above (browser memory
  // only), but joining hundreds of ids into a request key used to build a
  // 17 KiB string on every render and, on the wire, HTTP 431.
  const requestKey = `${focusId}\t${scope}\t${freshnessKey}`
  const debouncedKey = useDebouncedValue(requestKey, REFRESH_DEBOUNCE_MS)

  // Visibility fallback polling for the request pool: the event-driven
  // freshness key already refreshes on settled requests, but a WAITING row
  // produces no events between dispatch and first token. The poll is
  // SERIALIZED — the next tick is scheduled only after the previous fetch
  // settles — so a slow response is never cancelled mid-flight by the next
  // interval: with an active request the next poll runs 1s after the last
  // one finished, 5s idle, and a hidden tab schedules nothing (returning to
  // visibility refreshes once immediately).
  const [pollTick, setPollTick] = useState(0)
  const [pollSettle, setPollSettle] = useState(0)
  const [staleAt, setStaleAt] = useState<number | undefined>(undefined)
  const lastOkAtRef = useRef<number | undefined>(undefined)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fetchingRef = useRef(false)
  const fetchVersionRef = useRef(0)
  /** The last successful read. A late session-mirror / sessionStats delivery
   * bumps the freshness key inside the first debounce window and reruns the
   * effect; coalescing that run avoids two identical GETs on opening the tab. */
  const recentRef = useRef<{
    scopeKey: string
    idsKey: string
    retryToken: number
    pollTick: number
    at: number
    value: UsageSummary
    coalesced: boolean
  } | undefined>(undefined)
  // Scope changes are immediate; only event freshness is debounced. The
  // request and its cache identity must always describe the same range —
  // a constant-size root + scope, never an enumerated id list.
  const scopeKey = `${focusId}\t${scope}`

  const [summaryState] = useAsyncResource<UsageSummary>(
    signal => {
      clearTimeout(pollTimerRef.current)
      fetchingRef.current = true
      const version = ++fetchVersionRef.current
      const recent = recentRef.current
      // Only a mirror delivery coalesces: the id SET changed while the
      // scope / retry / poll intent stayed the same. A projection or
      // updatedAt churn (a real settled request) keeps the same ids and must
      // hit the route. Two debounce windows cover a mirror arriving a little
      // after mount; `coalesced` allows this at most once per range.
      const canReuse = recent !== undefined
        && !recent.coalesced
        && recent.idsKey !== scopeIdsKey
        && recent.scopeKey === scopeKey
        && recent.retryToken === retryToken
        && recent.pollTick === pollTick
        && Date.now() - recent.at < REFRESH_DEBOUNCE_MS * 2
      const settle = (value: UsageSummary): UsageSummary => {
        recentRef.current = { scopeKey, idsKey: scopeIdsKey, retryToken, pollTick, at: Date.now(), value, coalesced: canReuse }
        if (!signal.aborted) {
          lastOkAtRef.current = Date.now()
          setStaleAt(undefined)
        }
        return value
      }
      // Stale-snapshot honesty: a failed refresh keeps the previous
      // snapshot on screen (silentAfterFirst) and stamps the failure so the
      // pool shows "数据截至 …" instead of pretending to be live. A new
      // scope's first failure still lands in `error` (no snapshot to keep —
      // the scopeKey switch resets both the kept value and this stamp).
      const request: Promise<UsageSummary> = canReuse && recent !== undefined
        ? Promise.resolve(recent.value)
        : fetchSessionSummary(focusId, scope, signal)
      return request
        .then(settle)
        .catch((error: unknown) => {
          if (!signal.aborted && lastOkAtRef.current !== undefined) setStaleAt(lastOkAtRef.current)
          throw error
        })
        .finally(() => {
          // The scheduler's heartbeat: only a SETTLED fetch schedules the
          // next one (an aborted superseded attempt stays silent).
          if (version === fetchVersionRef.current) {
            fetchingRef.current = false
            if (!signal.aborted) setPollSettle(value => value + 1)
          }
        })
    },
    [debouncedKey.split('\t')[2], retryToken, pollTick],
    { silentAfterFirst: true, retryToken, scopeKey },
  )
  // A range switch also drops the freshness stamp — it belonged to the
  // previous range's last successful fetch, not to what is on screen now.
  useEffect(() => {
    lastOkAtRef.current = undefined
    setStaleAt(undefined)
  }, [scopeKey])

  const activeCount = summaryState.status === 'ready' ? summaryState.value.requestDetails?.activeCount ?? 0 : 0
  const hasActive = activeCount > 0
  useEffect(() => {
    if (document.visibilityState !== 'visible' || fetchingRef.current) return
    const timer = setTimeout(() => {
      if (document.visibilityState === 'visible') setPollTick(value => value + 1)
    }, hasActive ? 1_000 : 5_000)
    pollTimerRef.current = timer
    return () => { clearTimeout(timer) }
  }, [pollSettle, hasActive])
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && !fetchingRef.current) setPollTick(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  const stats = useMemo(() => {
    const values: Array<SessionStatsProjection | undefined> = scopeIds.map((id) => {
      if (id === sessionId) return liveStats
      return byId[id as SessionId]?.projectionValues?.sessionStats
    })
    return aggregateProjections(values)
  }, [scopeIds, sessionId, liveStats, byId])
  const ttftText = stats !== undefined && stats.ttftSteps > 0
    ? formatTtft(stats.ttftMs / stats.ttftSteps)
    : '—'
  const speedText = stats !== undefined && stats.decodeMs > 0
    ? formatSpeed(stats.decodeTokens / (stats.decodeMs / 1_000))
    : '—'

  const header = (
    <header className={styles['head']}>
      <div className={styles['headRight']}>
        <div className={styles['segmented']} role="group" aria-label={t('view.scope.label')}>
          <button
            type="button"
            className={scope === 'session' ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
            aria-pressed={scope === 'session'}
            onClick={() => setScope('session')}
          >
            {t('view.scope.session')}
          </button>
          <button
            type="button"
            className={scope === 'tree' ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
            aria-pressed={scope === 'tree'}
            onClick={() => setScope('tree')}
          >
            {t('view.scope.tree')}
          </button>
        </div>
      </div>
    </header>
  )

  if (summaryState.status === 'loading') {
    return (
      <div ref={rootRef} className={styles['root']} {...COMPOSER_OVERLAY}>
        <PricingAssociationProvider view={{ symbol: '￥', rate: 1 }} t={t}>
        {header}
        <p className={styles['muted']}>{t('loading')}</p>
        </PricingAssociationProvider>
      </div>
    )
  }
  if (summaryState.status === 'error') {
    return (
      <div ref={rootRef} className={styles['root']} {...COMPOSER_OVERLAY}>
        <PricingAssociationProvider view={{ symbol: '￥', rate: 1 }} t={t}>
        {header}
        <p className={styles['error']}>{t('loadFailed', { message: summaryState.message })}</p>
        <button type="button" className={styles['button']} onClick={retry}>{t('retry')}</button>
        </PricingAssociationProvider>
      </div>
    )
  }

  const summary = summaryState.value
  const view = currencyViewOf(summary)
  const { total } = summary
  return (
    <div ref={rootRef} className={styles['root']} {...COMPOSER_OVERLAY}>
    <PricingAssociationProvider resolutions={summary.modelResolutions} feedVersion={summary.feedVersion} view={view} t={t}>
      {header}
      {total.requests === 0 && (total.failures ?? 0) === 0
        // The session has no recorded requests (successful or failed); the
        // stat band is skipped but the subagent table below still renders
        // (children may hold usage even when this session's scoped summary
        // is empty).
        ? <p className={styles['empty']}>{t('view.empty')}</p>
        : (
          <>
            <div className={styles['cards']}>
              <RequestsStatCard
                requests={total.requests}
                failures={total.failures ?? 0}
                failuresByCode={total.failuresByCode}
                t={t}
              />
              <StatCard label={t('stat.cost')} value={costsAvailable(summary.costState) ? formatCost(summary.totalCost, view) : '—'} />
              <StatCard label={t('stat.totalTokens')} value={formatTokens(totalTokens(total))} />
              <StatCard label={t('stat.hitRate')} value={<HitRateText totals={total} />} />
              <StatCard label={t('view.ttft')} value={ttftText} />
              <StatCard label={t('view.speed')} value={`${speedText} tok/s`} />
            </div>
            <div className={styles['tokenStrip']}>
              <span>{t('stat.input')} <b>{formatTokens(total.inputTokens)}</b></span>
              <span>{t('stat.output')} <b>{formatTokens(total.outputTokens)}</b></span>
              <span>{t('stat.cacheRead')} <b>{formatTokens(total.cacheReadTokens)}</b></span>
              <span>{t('stat.cacheWrite')} <b>{formatTokens(total.cacheWriteTokens)}</b></span>
            </div>
            <PricingStatus costState={summary.costState} pricingUnavailableReason={summary.pricingUnavailableReason} associationStorageError={summary.associationStorageError} t={t} />
            {costsAvailable(summary.costState) && summary.unpricedModels.length > 0
              ? (
                <p className={styles['warning']} role="status">
                  {t('unpriced.warning', {
                    count: String(summary.unpricedModels.length),
                    models: summary.unpricedModels.join(', '),
                    zero: formatCost(0, view),
                  })}
                </p>
              )
              : null}
            <div className={styles['mid']}>
              <section className={styles['chartCol']}>
                <div className={styles['chartHead']}>
                  <h3 className={styles['subtitle']}>{t('view.chart.title')}</h3>
                  <div className={styles['segmented']} role="group" aria-label={t('chart.mode.label')}>
                    <button
                      type="button"
                      className={chartMode === 'interval' ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
                      aria-pressed={chartMode === 'interval'}
                      onClick={() => setChartMode('interval')}
                    >
                      {t('chart.mode.interval')}
                    </button>
                    <button
                      type="button"
                      className={chartMode === 'cumulative' ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
                      aria-pressed={chartMode === 'cumulative'}
                      onClick={() => setChartMode('cumulative')}
                    >
                      {t('chart.mode.cumulative')}
                    </button>
                  </div>
                </div>
                {/* Session-scoped reads carry the per-request series: the
                    trend plots one point per request. The whole-log settings
                    read has no series and falls back to the day/hour rows. */}
                <TrendChart
                  height={150}
                  rows={summary.byDay}
                  mode={chartMode}
                  t={t}
                  {...summary.requestSeries !== undefined ? { requests: summary.requestSeries } : {}}
                  {...summary.byDay.length === 1 ? { hours: summary.byHour } : {}}
                />
              </section>
              <section className={styles['modelCol']}>
                <h3 className={styles['subtitle']}>{t('byModel.title')}</h3>
                {summary.byModel.length > 0
                  ? (
                    <div className={styles['tableWrap']}>
                      <table className={styles['table']} aria-label={t('byModel.title')}>
                        <thead>
                          <tr>
                            <th className={styles['modelHead']}>{t('filter.model')}</th>
                            <th title={t('stat.successFail')}>{t('stat.requestColumn')}</th>
                            <th>{t('stat.input')}</th>
                            <th>{t('stat.output')}</th>
                            <th>{t('stat.cacheRead')}</th>
                            <th>{t('stat.cacheWrite')}</th>
                            <th>{t('stat.hitRate')}</th>
                            <th>{t('stat.cost')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.byModel.map(row => (
                            <tr key={row.model}>
                              <td className={styles['modelCell']}>
                                <span className={styles.modelIdentity}><span className={styles.modelName}>{row.model}</span>
                                  {summary.unpricedModels.includes(row.model) && <UnpricedModelTag model={row.model} t={t} />}
                                  <ModelAssociationBadge model={row.model} t={t} />
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
                              <td className={row.totals.inputTokens === 0 ? styles['zeroDim'] : undefined}>{formatTokens(row.totals.inputTokens)}</td>
                              <td className={row.totals.outputTokens === 0 ? styles['zeroDim'] : undefined}>{formatTokens(row.totals.outputTokens)}</td>
                              <td className={row.totals.cacheReadTokens === 0 ? styles['zeroDim'] : undefined}>{formatTokens(row.totals.cacheReadTokens)}</td>
                              <td className={row.totals.cacheWriteTokens === 0 ? styles['zeroDim'] : undefined}>{formatTokens(row.totals.cacheWriteTokens)}</td>
                              <td><HitRateText totals={row.totals} /></td>
                              <td className={styles['costCol']}>{costsAvailable(summary.costState) && !summary.unpricedModels.includes(row.model) ? formatCost(row.cost, view) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                  : <p className={styles['muted']}>{t('chart.empty')}</p>}
              </section>
            </div>
          </>
        )}
      {summary.requestDetails !== undefined && (
        <RequestPoolSections
          details={summary.requestDetails}
          focusId={focusId}
          view={view}
          {...staleAt !== undefined ? { staleAt } : {}}
          t={t}
        />
      )}
      <section className={styles['subagents']}>
        <div className={styles['subagentsHead']}>
          <h3 className={styles['subtitle']}>
            {t('view.subagents.title', { count: String(children.length) })}
          </h3>
          {(() => {
            // The up-navigation control sits with the subagent section it
            // returns from: the drill-in entry point is the row below.
            if (backParent === undefined) return null
            const parentSummary = byId[backParent as SessionId]
            if (parentSummary === undefined) return null
            const parentId = backParent as SessionId
            return (
              <button
                type="button"
                className={styles['back']}
                onClick={() => setFocusId(parentId)}
              >
                {t('view.back', { title: parentSummary.displayTitle ?? parentId })}
              </button>
            )
          })()}
        </div>
        {children.length === 0
          ? <p className={styles['muted']}>{t('view.subagents.none')}</p>
          : (
            <div
              ref={subagentsRef}
              onScroll={handleSubagentsScroll}
              className={styles['subagentsWrap']}
              tabIndex={0}
              role="region"
              aria-label={t('view.subagents.scroll')}
            >
              <table className={styles['table']} aria-label={t('view.subagents.title', { count: String(children.length) })}>
                <thead>
                  <tr>
                    <th className={styles['modelHead']}>{t('view.subagents.titleCol')}</th>
                    <th>{t('stat.requests')}</th>
                    <th>{t('stat.totalTokens')}</th>
                    <th>{t('stat.cost')}</th>
                    <th>{t('stat.hitRate')}</th>
                    <th>{t('view.ttft')}</th>
                    <th>{t('view.speed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {children.map(id => {
                    const child = byId[id as SessionId]
                    const row = summary.children?.[id]
                    // TTFT / throughput come from the host's record-derived
                    // breakdown, NOT the runtime mirror: finished subagents
                    // do not retain a sessionStats projection.
                    const timing = row?.timing
                    // A nested-subagent marker: the count of THIS child's own
                    // direct subagents, so the table signals before the
                    // drill-in that the row has a subtree of its own.
                    const nestedCount = directSubagentIds(byId, id, childIndex).length
                    return (
                      <tr key={id}>
                        <td className={styles['modelCell']}>
                          <button
                            type="button"
                            className={styles['childLink']}
                            onClick={() => setFocusId(id as SessionId)}
                          >
                            {child?.displayTitle ?? id}
                          </button>
                          {nestedCount > 0
                            ? (
                              <span
                                className={styles['nestedBadge']}
                                aria-label={t('view.subagents.nested', { count: String(nestedCount) })}
                              >
                                ({nestedCount})
                              </span>
                            )
                            : null}
                        </td>
                        <td>{row?.total.requests.toLocaleString() ?? '—'}</td>
                        <td>{row !== undefined ? formatTokens(totalTokens(row.total)) : '—'}</td>
                        <td className={styles['costCol']}>
                          {row !== undefined && costsAvailable(summary.costState) && costsAvailable(row.costState) ? formatCost(row.totalCost, view) : '—'}
                        </td>
                        <td>{row !== undefined ? <HitRateText totals={row.total} /> : '—'}</td>
                        <td>{timing !== undefined && timing.ttftSteps > 0 ? formatTtft(timing.ttftMs / timing.ttftSteps) : '—'}</td>
                        <td>{timing !== undefined && timing.decodeMs > 0 ? `${formatSpeed(timing.decodeTokens / (timing.decodeMs / 1_000))} tok/s` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
      {(total.requests > 0 || (total.failures ?? 0) > 0) && <p className={styles['note']}>{t('view.note')}</p>}
    </PricingAssociationProvider>
    </div>
  )
}
