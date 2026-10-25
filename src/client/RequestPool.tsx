/**
 * The conversation usage tab's request pool (最新请求 / 实时请求): the
 * active-first request panel (items[0], six fixed metrics in order: cache hit,
 * input, output, first token, latency, speed — with cost / cache read /
 * cache write demoted to the footer) plus the history table of up to 19
 * earlier rows (columns frozen in order: origin, state, time, model, cache
 * hit, input, output, first token, latency, speed, cost).
 *
 * Every figure comes from the server snapshot (`requestDetails`) — the
 * component never re-derives rates or speeds, never runs its own clock
 * (in-flight elapsed is server-anchored), and never fills an unknown with a
 * zero or a session mean. The 「缓存过低」 label is a low-hit heuristic the
 * server already gated through every exclusion; its tooltip says so.
 *
 * @module token-usage/client/RequestPool
 */

import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CurrencyView } from './format.ts'
import { bandOf, formatCost, formatRequestRate, formatRequestRateExact, formatTimeOfDay, formatTokens, formatTtft } from './format.ts'
import { bandClassOf } from './HitRateText.tsx'
import type { RequestDetailCache, RequestDetailView, SessionRequestDetails } from '../wire.ts'
import styles from './UsageView.module.css'

export interface RequestPoolProps {
  details: SessionRequestDetails
  /** The focused session: rows from it are 「本会话」, from its descendants
   * 「子会话」— the same mapping the subagent table's drill-in uses. */
  focusId: string
  view: CurrencyView
  /** Epoch ms of the last successful refresh; set while the latest refresh
   * failed and the panel kept its previous snapshot (the stale notice). */
  staleAt?: number
  t: TranslateNS<'token-usage'>
}

/** The state pill's color class (state is never color-only — the label text
 * and the metrics columns carry the same facts). */
function stateClassOf(state: RequestDetailView['state']): string {
  switch (state) {
    case 'failed': return styles['stateFailed'] ?? ''
    case 'cancelled':
    case 'interrupted':
    case 'waiting': return styles['statePending'] ?? ''
    case 'streaming': return styles['stateStreaming'] ?? ''
    default: return styles['stateDone'] ?? ''
  }
}

/** Numeric colour follows the summary cards, independently of label eligibility. */
function hitClassOf(cache: RequestDetailCache): string | undefined {
  if (cache.rate === undefined) return styles['zeroDim'] ?? ''
  return bandClassOf(bandOf(cache.rate))
}

/** The hit cell's tooltip: the low-hit explanation (with the raw-precision
 * note when rounding would hide a sub-threshold rate) or the exclusion
 * reason. Unknown figures explain their unknown instead of going silent. */
function hitTooltipOf(cache: RequestDetailCache, t: TranslateNS<'token-usage'>): string {
  if (cache.rate === undefined) {
    return cache.reason !== undefined ? t(`pool.excluded.${cache.reason}`) : ''
  }
  const display = formatRequestRate(cache.rate)
  if (cache.band === 'loss') {
    // Show raw precision when rounding hides why the loss label applies.
    const lines = [t('pool.cache.tooltip', { rate: display })]
    if (Number.parseFloat(display) >= 50) {
      lines.push(t('pool.cache.roundedDown', { rate: formatRequestRateExact(cache.rate) }))
    }
    return lines.join('\n')
  }
  if (cache.reason !== undefined) return t(`pool.excluded.${cache.reason}`)
  return ''
}

/** The hit cell keeps request precision, shared numeric colours, and its explanation. */
function HitCell({ cache, t }: { cache: RequestDetailCache; t: TranslateNS<'token-usage'> }): ReactNode {
  const text = formatRequestRate(cache.rate)
  const tooltip = hitTooltipOf(cache, t)
  const content = <span className={hitClassOf(cache)}>{text}</span>
  return tooltip === ''
    ? content
    : <Tooltip label={tooltip} side="top" delayMs={100}><span tabIndex={0}>{content}</span></Tooltip>
}

/** The model + label pair as one non-breaking inline group: the model name
 * compresses first, the badge never wraps onto its own line. */
function ModelCell({ detail, cache, t }: { detail: RequestDetailView; cache: RequestDetailCache; t: TranslateNS<'token-usage'> }): ReactNode {
  const model = detail.responseModel ?? detail.requestedModel
  const name = (
    <Tooltip label={detail.responseModel !== undefined && detail.responseModel !== detail.requestedModel
      ? `${detail.requestedModel} → ${detail.responseModel}`
      : model} side="top" delayMs={100}>
      <span className={styles['modelName']} tabIndex={0}>{model}</span>
    </Tooltip>
  )
  if (cache.band !== 'loss') {
    return <span className={styles['modelInline']}>{name}</span>
  }
  return (
    <span className={styles['modelInline']}>
      {name}
      <Tooltip label={hitTooltipOf(cache, t)} side="top" delayMs={100}>
        <span className={styles['cacheLoss']} tabIndex={0}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10.3 3.8-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.2l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></svg>
          {t('pool.cache.label')}
        </span>
      </Tooltip>
    </span>
  )
}

/** The status cell text: lifecycle states first, then the compaction kind
 * marker (kind and state are separate dimensions; the origin column never
 * doubles as either). */
function stateTextOf(detail: RequestDetailView, t: TranslateNS<'token-usage'>): string {
  return t(`pool.state.${detail.state}`)
}

/** Latency column: settled rows show their measured latency; in-flight rows
 * show the server-anchored elapsed (已耗时); untimed rows stay —. */
function latencyTextOf(detail: RequestDetailView): string {
  if (detail.state === 'waiting' || detail.state === 'streaming') {
    return detail.elapsedMs !== undefined ? formatTtft(detail.elapsedMs) : '—'
  }
  return detail.latencyMs !== undefined ? formatTtft(detail.latencyMs) : '—'
}

/** Speed column: the server's settled gate only — in-flight rows read —
 * (the lifecycle contract: no live token counts exist to average over; the
 * component double-checks the state so a stale field can never read as a
 * live speed). */
function speedTextOf(detail: RequestDetailView): string {
  return detail.state === 'completed' && detail.speed !== undefined
    ? `${String(Math.round(detail.speed))} tok/s`
    : '—'
}

/** Cost column: priced figures render through the view; unpriced and
 * usage-less rows show — (never a fabricated zero). */
function costTextOf(detail: RequestDetailView, view: CurrencyView): string {
  return detail.cost !== undefined && detail.pricingStatus === 'priced' ? formatCost(detail.cost, view) : '—'
}

/** Token-bucket text: a present count formats; an absent one stays —
 * (explicit 0 is a count and renders 0). */
function tokenTextOf(value: number | undefined): string {
  return value !== undefined ? formatTokens(value) : '—'
}

function MetricValue({ text, unit = '' }: { text: string; unit?: string }): ReactNode {
  // Units stay visually quiet; the full text remains one accessible value.
  const match = text.match(/^(.*?)(tok\/s|s)$/)
  const value = match?.[1] ?? text
  const suffix = text === '—' ? '' : match?.[2] ?? unit
  return <span>{value}{suffix !== '' && <span className={styles['metricUnit']}>{suffix}</span>}</span>
}

/** The in-flight notice line under the latest panel, plus the priced /
 * untimed notes the state matrix requires. */
function noticeOf(detail: RequestDetailView, t: TranslateNS<'token-usage'>): string {
  switch (detail.state) {
    case 'waiting': return t('pool.note.waiting')
    case 'streaming': return t('pool.note.streaming')
    case 'cancelled': return t('pool.note.cancelled')
    case 'interrupted': return t('pool.note.interrupted')
    case 'failed': return t('pool.note.failed', { code: detail.failureCode ?? '' })
    default: break
  }
  if (detail.pricingStatus === 'unpriced') return t('pool.note.unpriced')
  if (detail.inputTokens === undefined || detail.outputTokens === undefined) return t('pool.note.noUsage')
  if (detail.latencyMs === undefined || detail.firstTokenLatencyMs === undefined) return t('pool.note.untimed')
  if (detail.cache.band === 'excluded' || detail.cache.band === 'unknown') {
    return detail.cache.reason !== undefined ? t(`pool.excluded.${detail.cache.reason}`) : ''
  }
  return ''
}

/** One history row: the eleven columns in frozen order — origin, state,
 * time, model+label, cache hit, input, output, first token, latency, speed,
 * cost. Numbers right-aligned via the shared table CSS. */
function PoolRow({ detail, focusId, view, t }: { detail: RequestDetailView; focusId: string; view: CurrencyView; t: TranslateNS<'token-usage'> }): ReactNode {
  const origin = detail.sessionId === focusId
  const time = detail.orderBasis === 'record'
    ? detail.recordTime ?? detail.orderAt
    : detail.startedAt ?? detail.orderAt
  return (
    <tr>
      <td data-label={t('pool.col.origin')} className={styles['poolOrigin']}>{t(origin ? 'pool.origin.self' : 'pool.origin.child')}{detail.kind === 'compaction' ? ` · ${t('pool.kind.compaction')}` : ''}</td>
      <td data-label={t('pool.col.state')} className={`${styles['poolState']} ${stateClassOf(detail.state)}`}>{stateTextOf(detail, t)}</td>
      <td data-label={t('pool.col.time')} className={styles['poolTime']}><time dateTime={new Date(time).toISOString()}>{formatTimeOfDay(time)}</time></td>
      <td data-label={t('pool.col.model')} className={styles['poolModel']}><ModelCell detail={detail} cache={detail.cache} t={t} /></td>
      <td data-label={t('pool.col.hit')}><HitCell cache={detail.cache} t={t} /></td>
      <td data-label={t('pool.col.input')} title={t('pool.metric.hitInput')}>{tokenTextOf(detail.inputTokens)}</td>
      <td data-label={t('pool.col.output')}>{tokenTextOf(detail.outputTokens)}</td>
      <td data-label={t('pool.col.ttft')}>{detail.firstTokenLatencyMs !== undefined ? formatTtft(detail.firstTokenLatencyMs) : '—'}</td>
      <td data-label={t('pool.col.latency')}>{latencyTextOf(detail)}</td>
      <td data-label={t('pool.col.speed')} title={detail.state === 'waiting' || detail.state === 'streaming' ? t('pool.metric.speedSettled') : undefined}>{speedTextOf(detail)}</td>
      <td data-label={t('pool.col.cost')} className={styles['costCol']}>{costTextOf(detail, view)}</td>
    </tr>
  )
}

/**
 * Both request-pool sections: the latest panel and the history table. The
 * panel renders even for an empty pool (the empty prompt) — a session with
 * zero completed requests but one waiting must still show the area, with
 * the waiting row in it.
 */
export function RequestPoolSections({ details, focusId, view, staleAt, t }: RequestPoolProps): ReactNode {
  const { items, limit, activeCount } = details
  const latest = items[0]
  const history = items.slice(1)
  const beyond = Math.max(0, activeCount - items.filter(item => item.state === 'waiting' || item.state === 'streaming').length)

  const latestPanel = (
    <section className={styles['poolSection']} aria-label={t('pool.latest.title')}>
      <div className={styles['poolHead']}>
        <h3 className={styles['subtitle']}>{t('pool.latest.title')}</h3>
        <span className={styles['poolContext']}>{t('pool.latest.context')}</span>
      </div>
      {latest === undefined
        ? <div className={styles['latestPanel']}><div className={styles['poolEmpty']}>{t('pool.empty')}</div></div>
        : (
            (() => {
              const inFlight = latest.state === 'waiting' || latest.state === 'streaming'
              const origin = latest.sessionId === focusId
              const time = latest.orderBasis === 'record'
                ? latest.recordTime ?? latest.orderAt
                : latest.startedAt ?? latest.orderAt
              const notice = noticeOf(latest, t)
              return (
                <div className={styles['latestPanel']}>
                  <div className={styles['requestIdentity']}>
                    <span className={styles['poolBadge']}>{t(origin ? 'pool.origin.self' : 'pool.origin.child')}{latest.kind === 'compaction' ? ` · ${t('pool.kind.compaction')}` : ''}</span>
                    <span className={`${styles['poolState']} ${stateClassOf(latest.state)}`}><span className={styles['statusDot']} aria-hidden="true" />{stateTextOf(latest, t)}</span>
                    <ModelCell detail={latest} cache={latest.cache} t={t} />
                    <span className={styles['poolContext']}><time dateTime={new Date(time).toISOString()}>{formatTimeOfDay(time)}</time></span>
                  </div>
                  <div className={styles['requestMetrics']}>
                    <div>
                      <div className={styles['metricValue']}><HitCell cache={latest.cache} t={t} /></div>
                      <div className={styles['metricLabel']}>{t('pool.col.hit')}</div>
                    </div>
                    <div>
                      <div className={styles['metricValue']}><MetricValue text={tokenTextOf(latest.inputTokens)} unit="tok" /></div>
                      <div className={styles['metricLabel']}>{t('pool.col.input')}</div>
                    </div>
                    <div>
                      <div className={styles['metricValue']}><MetricValue text={tokenTextOf(latest.outputTokens)} unit="tok" /></div>
                      <div className={styles['metricLabel']}>{t('pool.col.output')}</div>
                    </div>
                    <div>
                      <div className={styles['metricValue']}><MetricValue text={latest.firstTokenLatencyMs !== undefined ? formatTtft(latest.firstTokenLatencyMs) : '—'} /></div>
                      <div className={styles['metricLabel']}>{t('pool.col.ttft')}</div>
                    </div>
                    <div>
                      <div className={styles['metricValue']}><MetricValue text={latencyTextOf(latest)} /></div>
                      <div className={styles['metricLabel']} title={inFlight ? t('pool.metric.elapsed') : undefined}>{inFlight ? t('pool.metric.elapsedShort') : t('pool.col.latency')}</div>
                    </div>
                    <div>
                      <div className={styles['metricValue']}><MetricValue text={speedTextOf(latest)} /></div>
                      <div className={styles['metricLabel']}>{t('pool.col.speed')}</div>
                    </div>
                  </div>
                  <div className={styles['requestFooter']}>
                    <div className={styles['requestBuckets']}>
                      <span>{t('pool.metric.cost')} <b>{costTextOf(latest, view)}</b></span>
                      <span>{t('pool.metric.cacheRead')} <b>{tokenTextOf(latest.cacheReadTokens)}</b></span>
                      <span>{t('pool.metric.cacheWrite')} <b>{tokenTextOf(latest.cacheWriteTokens)}</b></span>
                    </div>
                    {(staleAt !== undefined || latest.state !== 'completed') && (
                      <span className={styles['poolContext']}>{staleAt !== undefined ? t('pool.asOf', { time: formatTimeOfDay(staleAt) }) : t(inFlight ? 'pool.pending' : 'pool.ended')}</span>
                    )}
                  </div>
                  {notice !== '' && <div className={`${styles['poolNotice']} ${latest.state === 'failed' ? styles['poolNoticeError'] : latest.state === 'completed' ? styles['poolNoticeNeutral'] : ''}`}>{notice}</div>}
                </div>
              )
            })()
          )}
    </section>
  )

  const poolTable = (
    <section className={styles['poolSection']} aria-label={t('pool.title')}>
      <div className={styles['poolHead']}>
        <h3 className={styles['subtitle']}>
          {t('pool.title')}
          <span className={styles['poolContext']}> {t('pool.historyCount', { count: String(history.length) })}</span>
        </h3>
        <span className={styles['poolContext']}>
          <span>{t('pool.newest')}</span>{' · '}<span>{t('pool.count', { count: String(items.length), limit: String(limit) })}</span>
          {beyond > 0 ? ` · ${t('pool.activeBeyond', { count: String(beyond) })}` : ''}
        </span>
      </div>
      {staleAt !== undefined && (
        <div className={styles['poolNotice']} role="status">
          {t('pool.stale', { time: formatTimeOfDay(staleAt) })}
        </div>
      )}
      {history.length === 0
        ? <div className={styles['poolEmpty']}>{items.length > 0 ? t('pool.emptyHistory') : t('pool.empty')}</div>
        : (
            <div className={styles['poolTableWrap']} tabIndex={0} role="region" aria-label={t('pool.history.scroll')}>
              <table className={styles['poolTable']} aria-label={t('pool.title')}>
                <thead>
                  <tr>
                    <th className={styles['poolModelHead']}>{t('pool.col.origin')}</th>
                    <th>{t('pool.col.state')}</th>
                    <th>{t('pool.col.time')}</th>
                    <th className={styles['poolModelHead']}>{t('pool.col.model')}</th>
                    <th>{t('pool.col.hit')}</th>
                    <th>{t('pool.col.input')}</th>
                    <th>{t('pool.col.output')}</th>
                    <th>{t('pool.col.ttft')}</th>
                    <th>{t('pool.col.latency')}</th>
                    <th>{t('pool.col.speed')}</th>
                    <th>{t('pool.col.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(detail => <PoolRow key={detail.id} detail={detail} focusId={focusId} view={view} t={t} />)}
                </tbody>
              </table>
            </div>
          )}
    </section>
  )

  return (
    <>
      {latestPanel}
      {poolTable}
    </>
  )
}
