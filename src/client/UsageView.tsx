/**
 * The conversation view tab "Usage" (browser half): one entry of the
 * `conversation.view` slot ring (beside Chat / Trajectory), rendering the
 * per-session token & cost dashboard for the ACTIVE conversation. The tab
 * shows the focused session's totals (4 token buckets, cost, hit rate,
 * TTFT average, decode throughput) with a scope switch between the session
 * alone and its whole subagent subtree, a per-hour trend chart and the
 * per-model table from the host stats route (`sessionId`-scoped), and a
 * subagent table below — each row drill-in switches the focus to that child.
 *
 * Data sources: token/cost figures come from the host route (the pricing
 * rule chain's authority); TTFT and throughput come from the framework's
 * retained `sessionStats` projection values (`useProjection` for the current
 * session, `byId[].projectionValues` for every other session), which cover
 * the whole log including history written before this plugin was installed.
 * A footnote states the two scopes so the difference is not a surprise.
 *
 * @module token-usage/client/UsageView
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot, SessionListState, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
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
import { HitRateText } from './HitRateText.tsx'
import { aggregateProjections, buildChildIndex, directSubagentIds, subagentParentOf, subtreeIds } from './session-stats.ts'
import { StatCard } from './StatCard.tsx'
import { TrendChart } from './TrendChart.tsx'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import styles from './UsageView.module.css'

/** The view's scope switch: the session alone, or its whole subagent subtree. */
export type UsageScope = 'session' | 'tree'

/** Refresh debounce: bursts of session-mirror updates (one request's events)
 * collapse into a single fetch, so the dashboard refreshes at REQUEST
 * granularity instead of per event or per turn. */
const REFRESH_DEBOUNCE_MS = 250

/** Props: the conversation-view runtime seat (standard kit) plus the locale seat. */
export interface UsageViewProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useSessions: SnapshotSelectorHook<SessionListState>
  useProjection: UseProjection
  sessionId: SessionId
  t: TranslateNS<'token-usage'>
}

/** One fetch of the session-scoped summary from the host stats route,
 * including the direct-child breakdown for the subagent table. */
function fetchSessionSummary(
  sessionIds: readonly string[],
  childGroups: readonly (readonly string[])[],
  signal: AbortSignal,
): Promise<UsageSummary> {
  return fetch(STATS_PATH + encodeStatsQuery({ sessionIds, childGroups, fields: 'session' }), { signal })
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
  // The dashboard focus: the active conversation until a subagent row is
  // drilled into. Reset when the conversation itself changes — the pane
  // may reuse this instance across session switches.
  const [focusId, setFocusId] = useState<SessionId>(sessionId)
  useEffect(() => { setFocusId(sessionId) }, [sessionId])
  const [retryToken, setRetryToken] = useState(0)
  const retry = (): void => { setRetryToken(token => token + 1) }

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
  // Tree scope folds each direct child with its own descendants so the
  // subagent-table numbers add back up to the header total.
  const childGroups = useMemo(
    () => children.map(id => (scope === 'tree' ? subtreeIds(byId, id, childIndex) : [id])),
    [children, scope, byId, childIndex],
  )
  const backParent = subagentParentOf(byId, focusId)
  // Debounce on a stable string: membership + per-session updatedAt so a
  // finished request refreshes figures, while unrelated byId identity
  // churn does not. The first paint already has a key (no null sentinel)
  // so mount does not double-fetch.
  const freshnessKey = [...new Set([...scopeIds, ...children])]
    .map(id => `${id}:${String(byId[id as SessionId]?.updatedAt ?? 0)}`)
    .join(',')
  const requestKey = `${scopeIds.join('\n')}\n\t${childGroups.map(group => group.join(',')).join(';')}\n\t${freshnessKey}`
  const debouncedKey = useDebouncedValue(requestKey, REFRESH_DEBOUNCE_MS)
  const [summaryState] = useAsyncResource<UsageSummary>(
    signal => {
      const [idsPart, groupsPart] = debouncedKey.split('\n\t')
      const sessionIds = (idsPart ?? '').split('\n').filter(id => id !== '')
      const childGroups = (groupsPart ?? '').split(';').filter(group => group !== '').map(group => group.split(','))
      return fetchSessionSummary(sessionIds, childGroups, signal)
    },
    [debouncedKey, retryToken],
    { silentAfterFirst: true, retryToken },
  )

  // TTFT / throughput come from the framework's retained projections: the
  // live session via useProjection, every other session from the mirror.
  // Pass values directly to aggregateProjections (rather than synthesising
  // a Rows-like map) so the producer stays typed at `SessionId`.
  const liveStats = useProjection('sessionStats')
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
      <div ref={rootRef} className={styles['root']}>
        {header}
        <p className={styles['muted']}>{t('loading')}</p>
      </div>
    )
  }
  if (summaryState.status === 'error') {
    return (
      <div ref={rootRef} className={styles['root']}>
        {header}
        <p className={styles['error']}>{t('loadFailed', { message: summaryState.message })}</p>
        <button type="button" className={styles['button']} onClick={retry}>{t('retry')}</button>
      </div>
    )
  }

  const summary = summaryState.value
  const view = currencyViewOf(summary)
  const { total } = summary
  return (
    <div ref={rootRef} className={styles['root']}>
      {header}
      {total.requests === 0
        // The session has no recorded requests; the stat band is skipped
        // but the subagent table below still renders (children may hold
        // usage even when this session's scoped summary is empty).
        ? <p className={styles['empty']}>{t('view.empty')}</p>
        : (
          <>
            <div className={styles['cards']}>
              <StatCard label={t('stat.requests')} value={total.requests.toLocaleString()} />
              <StatCard label={t('stat.cost')} value={formatCost(summary.totalCost, view)} />
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
            {summary.unpricedModels.length > 0
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
                <h3 className={styles['subtitle']}>{t('view.chart.title')}</h3>
                {/* Session-scoped reads carry the per-request series: the
                    trend plots one point per request. The whole-log settings
                    read has no series and falls back to the day/hour rows. */}
                <TrendChart
                  rows={summary.byDay}
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
                            <th>{t('stat.requests')}</th>
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
                              <td className={styles['modelCell']}>{row.model}</td>
                              <td>{row.totals.requests.toLocaleString()}</td>
                              <td>{formatTokens(row.totals.inputTokens)}</td>
                              <td>{formatTokens(row.totals.outputTokens)}</td>
                              <td>{formatTokens(row.totals.cacheReadTokens)}</td>
                              <td>{formatTokens(row.totals.cacheWriteTokens)}</td>
                              <td><HitRateText totals={row.totals} /></td>
                              <td>{formatCost(row.cost, view)}</td>
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
            <div className={styles['tableWrap']}>
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
                    const childStats = aggregateProjections([
                      byId[id as SessionId]?.projectionValues?.sessionStats,
                    ])
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
                        <td>
                          {row !== undefined ? formatCost(row.totalCost, view) : '—'}
                        </td>
                        <td>{row !== undefined ? <HitRateText totals={row.total} /> : '—'}</td>
                        <td>{childStats !== undefined && childStats.ttftSteps > 0 ? formatTtft(childStats.ttftMs / childStats.ttftSteps) : '—'}</td>
                        <td>{childStats !== undefined && childStats.decodeMs > 0 ? `${formatSpeed(childStats.decodeTokens / (childStats.decodeMs / 1_000))} tok/s` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
      {total.requests > 0 && <p className={styles['note']}>{t('view.note')}</p>}
    </div>
  )
}
