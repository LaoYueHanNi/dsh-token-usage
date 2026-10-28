/**
 * The conversation usage tab's request pool (最新请求 / 实时请求): the
 * active-first request panel (items[0], six fixed metrics in order: cache hit,
 * input, output, first token, latency, speed — with cost / cache read /
 * cache write demoted to the footer) plus the history table of up to 19
 * earlier rows (columns frozen in order: origin, state, time, model, cache
 * hit, input, output, cache read, cache write, first token, latency, speed,
 * cost). The cache-write column is omitted when every visible request lacks
 * a reported write bucket.
 *
 * Every figure comes from the server snapshot (`requestDetails`) — the
 * component never re-derives rates or speeds, never runs its own clock
 * (in-flight elapsed is server-anchored), and never fills an unknown with a
 * zero or a session mean. The 「缓存过低」 label is a low-hit heuristic the
 * server already gated through every exclusion; its tooltip says so.
 *
 * @module token-usage/client/RequestPool
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CurrencyView } from './format.ts'
import { bandOf, formatCost, formatRequestRate, formatRequestRateExact, formatTimeOfDay, formatTokens, formatTtft } from './format.ts'
import { bandClassOf } from './HitRateText.tsx'
import type { CompactionAttributionItem, RequestDetailCache, RequestDetailView, SessionRequestDetails } from '../wire.ts'
import type { ConversationStatus } from '../wire.ts'
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
 * reason. Unknown figures explain their unknown instead of going silent.
 * The compaction attribution (when the row carries one) rides the same
 * tooltip as its closing section — real-world feedback dropped the standalone
 * badge as redundant next to the 缓存过低 marker, and the causal chain reads
 * exactly where the rate is questioned. The wording says the prefix WAS
 * rewritten and cache behaviour MAY be affected — never that compaction
 * caused a cache loss, because a high-hit row can carry the same attribution
 * (the miss severity depends on the earliest rewritten position, which the
 * plugin cannot see). */
function hitTooltipOf(cache: RequestDetailCache, t: TranslateNS<'token-usage'>, attribution?: readonly CompactionAttributionItem[]): string {
  const lines: string[] = []
  if (cache.rate === undefined) {
    if (cache.reason !== undefined) lines.push(t(`pool.excluded.${cache.reason}`))
  } else {
    const display = formatRequestRate(cache.rate)
    if (cache.band === 'loss') {
      lines.push(t('pool.cache.tooltip', { rate: display }))
      // Show raw precision when rounding hides why the loss label applies.
      if (Number.parseFloat(display) >= 50) {
        lines.push(t('pool.cache.roundedDown', { rate: formatRequestRateExact(cache.rate) }))
      }
    } else if (cache.reason !== undefined) {
      lines.push(t(`pool.excluded.${cache.reason}`))
    }
  }
  if (attribution !== undefined) {
    lines.push(t('pool.attribution.prefix'))
    for (const item of attribution) {
      lines.push(item.kind === 'prune'
        ? t('pool.attribution.prune', { count: String(item.count), tokens: formatTokens(item.shadowedTokenCount) })
        : t('pool.attribution.summary', { tokens: formatTokens(item.shadowedTokenCount) }))
    }
  }
  return lines.join('\n')
}

/** The hit cell keeps request precision, shared numeric colours, and its explanation. */
function HitCell({ cache, attribution, t }: { cache: RequestDetailCache; attribution?: readonly CompactionAttributionItem[] | undefined; t: TranslateNS<'token-usage'> }): ReactNode {
  const text = formatRequestRate(cache.rate)
  const tooltip = hitTooltipOf(cache, t, attribution)
  const content = <span className={hitClassOf(cache)}>{text}</span>
  return tooltip === ''
    ? content
    : <Tooltip label={tooltip} side="top" delayMs={100}><span tabIndex={0}>{content}</span></Tooltip>
}

/** The model + kind-badge pair as one non-breaking inline group: the model
 * name compresses first, the kind badge (auxiliary subtype or compaction)
 * never wraps onto its own line. Kind is always the model cell's badge —
 * the origin column states only whose session issued the request. */
function ModelCell({ detail, cache, t }: { detail: RequestDetailView; cache: RequestDetailCache; t: TranslateNS<'token-usage'> }): ReactNode {
  const rawModel = detail.responseModel ?? detail.requestedModel
  const model = detail.modelId ?? rawModel
  const modelTooltip = model !== rawModel
    ? `${rawModel} → ${model}`
    : detail.responseModel !== undefined && detail.responseModel !== detail.requestedModel
      ? `${detail.requestedModel} → ${detail.responseModel}`
      : model
  const name = (
    <Tooltip label={modelTooltip} side="top" delayMs={100}>
      <span className={styles['modelName']} tabIndex={0}>{model}</span>
    </Tooltip>
  )
  const kindLabel = detail.kind === 'aux' && detail.auxKind !== undefined
    ? t(`pool.kind.${detail.auxKind}`)
    : detail.kind === 'compaction'
      ? t('pool.kind.compaction')
      : undefined
  // No attribution badge of its own: the rewrite's causal chain lives in the
  // hit cell's tooltip (real-world feedback found a standalone pill redundant
  // next to the 缓存过低 marker). The loss marker shares the same tooltip, so
  // it explains the attribution too.
  if (cache.band !== 'loss') {
    return <span className={styles['modelInline']}>
      {name}
      {kindLabel !== undefined && <span className={styles['auxKind']} aria-label={kindLabel}>{kindLabel}</span>}
    </span>
  }
  return (
    <span className={styles['modelInline']}>
      {name}
      {kindLabel !== undefined && <span className={styles['auxKind']} aria-label={kindLabel}>{kindLabel}</span>}
      <Tooltip label={hitTooltipOf(cache, t, detail.compactionAttribution)} side="top" delayMs={100}>
        <span className={styles['cacheLoss']} tabIndex={0}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10.3 3.8-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.2l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></svg>
          {t('pool.cache.label')}
        </span>
      </Tooltip>
    </span>
  )
}

/** The status cell carries the lifecycle state only: kind is the model
 * cell's badge, origin stays in the origin column — no dimension doubles
 * as another. */
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

/** The panel's one-line notice: what it shows, how it reads, and the full
 * text behind the tooltip. `text` is the slot's line; `full` never drops a
 * fact the reader would otherwise lose. */
interface PanelNotice {
  /** 页脚右槽显示的一行文本。 */
  text: string
  /** Tooltip 的完整说明（可能比显示的长：会话状态 + 请求自身的诊断）。 */
  full: string
  /** 语气：`pending` 进行中（琥珀）、`error` 失败（红）、`neutral` 已结算（灰）。 */
  tone: 'pending' | 'error' | 'neutral'
}

/** 已结算请求自身的诊断说明：辅助请求不重复解释（紧凑标记已经说明），
 * 缓存排除与计时/用量/定价的缺口各自说明自己。 */
function diagnosticOf(detail: RequestDetailView, t: TranslateNS<'token-usage'>): string {
  if (detail.kind === 'aux') return ''
  if (detail.pricingStatus === 'unpriced') return t('pool.note.unpriced')
  if (detail.inputTokens === undefined || detail.outputTokens === undefined) return t('pool.note.noUsage')
  if (detail.latencyMs === undefined || detail.firstTokenLatencyMs === undefined) return t('pool.note.untimed')
  if (detail.cache.band === 'excluded' || detail.cache.band === 'unknown') {
    return detail.cache.reason !== undefined ? t(`pool.excluded.${detail.cache.reason}`) : ''
  }
  return ''
}

/** The panel's notice: the conversation's state first (waiting for a tool
 * result / this turn is done / retrying after a failure), then the request's
 * own lifecycle, then the settled request's diagnostic. A lower-priority
 * fact never disappears — it moves into the tooltip instead, so both stay
 * reachable. */
function noticeOf(
  detail: RequestDetailView,
  conversation: ConversationStatus | undefined,
  t: TranslateNS<'token-usage'>,
): PanelNotice | undefined {
  const one = (text: string, tone: PanelNotice['tone']): PanelNotice => ({ text, full: text, tone })
  // The request's own lifecycle note. A settled (successful) row has none.
  const own = ((): PanelNotice | undefined => {
    switch (detail.state) {
      case 'waiting': return one(t('pool.note.waiting'), 'pending')
      case 'streaming': return one(t('pool.note.streaming'), 'pending')
      case 'cancelled': return one(t('pool.note.cancelled'), 'pending')
      case 'interrupted': return one(t('pool.note.interrupted'), 'pending')
      case 'failed': return one(t('pool.note.failed', { code: detail.failureCode ?? '' }), 'error')
      default: return undefined
    }
  })()
  // The settled request's own diagnostic — only a successful row carries one
  // (a failed attempt explains itself in its own note).
  const diagnostic = detail.state === 'completed' ? diagnosticOf(detail, t) : ''
  // The conversation's state is the headline; everything it outranks follows
  // it into the tooltip.
  const conversationNotice = (text: string, tone: PanelNotice['tone'], rest: string): PanelNotice => ({
    text,
    full: [text, rest, own?.text ?? '', diagnostic].filter(part => part !== '').join(' · '),
    tone,
  })
  if (conversation?.state === 'retrying') {
    const retry = conversation.retry
    const count = String(retry?.count ?? 1)
    const text = retry !== undefined && retry.max > 0
      ? t('pool.note.retrying', { count, max: String(retry.max) })
      : t('pool.note.retryingAlways', { count })
    const wait = retry === undefined
      ? ''
      : t('pool.note.retryWait', {
          seconds: String(Math.max(1, Math.round(retry.delayMs / 1000))),
          code: retry.code ?? '—',
        })
    return conversationNotice(text, 'pending', wait)
  }
  if (conversation?.state === 'awaiting-tool') {
    return conversationNotice(t('pool.note.awaitingTool'), 'pending', '')
  }
  if (conversation?.state === 'turn-complete') {
    return conversationNotice(t('pool.note.turnComplete'), 'neutral', '')
  }
  if (own !== undefined) {
    return diagnostic === '' ? own : { ...own, full: `${own.full} · ${diagnostic}` }
  }
  return diagnostic === '' ? undefined : one(diagnostic, 'neutral')
}

/** Fixed-layout column floors in px, in table order (origin, state, time,
 * model, cache hit, input, output, cache read, first token, latency, speed,
 * cost): each is the smallest width that column's content ever needs, so
 * `table-layout: fixed` can treat them as true floors — the pane shares
 * whatever surplus remains equally across all columns, and once the pane
 * can no longer fit the floors the table scrolls. The optional cache-write
 * column carries its own floor. */
const POOL_COL_FLOORS: readonly number[] = [52, 52, 64, 120, 56, 52, 52, 56, 44, 52, 72, 60]
const POOL_COL_FLOOR_CACHE_WRITE = 56

/** One history row: the metrics stay in the visible order cache hit, input,
 * output, cache read, optional cache write, first token, latency, speed, cost.
 * Numbers right-aligned via the shared table CSS. */
function PoolRow({ detail, focusId, view, showCacheWrite, t }: { detail: RequestDetailView; focusId: string; view: CurrencyView; showCacheWrite: boolean; t: TranslateNS<'token-usage'> }): ReactNode {
  const origin = detail.sessionId === focusId
  const time = detail.orderBasis === 'record'
    ? detail.recordTime ?? detail.orderAt
    : detail.startedAt ?? detail.orderAt
  return (
    <tr>
      <td data-label={t('pool.col.origin')} className={styles['poolOrigin']}>{t(origin ? 'pool.origin.self' : 'pool.origin.child')}</td>
      <td data-label={t('pool.col.state')} className={`${styles['poolState']} ${stateClassOf(detail.state)}`}>{stateTextOf(detail, t)}</td>
      <td data-label={t('pool.col.time')} className={styles['poolTime']}><time dateTime={new Date(time).toISOString()}>{formatTimeOfDay(time)}</time></td>
      <td data-label={t('pool.col.model')} className={styles['poolModel']}><ModelCell detail={detail} cache={detail.cache} t={t} /></td>
      <td data-label={t('pool.col.hit')}><HitCell cache={detail.cache} attribution={detail.compactionAttribution} t={t} /></td>
      <td data-label={t('pool.col.input')} title={t('pool.metric.hitInput')}>{tokenTextOf(detail.inputTokens)}</td>
      <td data-label={t('pool.col.output')}>{tokenTextOf(detail.outputTokens)}</td>
      <td data-label={t('pool.col.cacheRead')}>{tokenTextOf(detail.cacheReadTokens)}</td>
      {showCacheWrite && <td data-label={t('pool.col.cacheWrite')}>{tokenTextOf(detail.cacheWriteTokens)}</td>}
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
  const showCacheWrite = items.some(item => item.cacheWriteTokens !== undefined)
  const colFloors = showCacheWrite ? [...POOL_COL_FLOORS, POOL_COL_FLOOR_CACHE_WRITE] : POOL_COL_FLOORS
  const beyond = Math.max(0, activeCount - items.filter(item => item.state === 'waiting' || item.state === 'streaming').length)
  // Scrollbar fade: the wrapper's thumb tints in only while the pane is
  // being scrolled, then fades back 800ms after the last event (the timer
  // dies with the component). Direct classList writes — no re-render.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const wrapTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(wrapTimer.current), [])
  const handleWrapScroll = (): void => {
    const box = wrapRef.current
    const cls = styles['scrolling']
    if (box === null || cls === undefined) return
    box.classList.add(cls)
    window.clearTimeout(wrapTimer.current)
    wrapTimer.current = window.setTimeout(() => {
      box.classList.remove(cls)
    }, 800)
  }

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
              const notice = noticeOf(latest, details.conversation, t)
              // The note's colour follows its tone: failed reads as an error,
              // a settled note as quiet text, an in-flight / awaiting-tool note
              // as the amber 「still running」 voice.
              const noteClass = `${styles['requestNote']} ${notice?.tone === 'error'
                ? styles['requestNoteError'] ?? ''
                : notice?.tone === 'neutral'
                  ? styles['requestNoteNeutral'] ?? ''
                  : ''}`
              return (
                <div className={styles['latestPanel']}>
                  <div className={styles['requestIdentity']}>
                    <span className={styles['poolBadge']}>{t(origin ? 'pool.origin.self' : 'pool.origin.child')}</span>
                    <span className={`${styles['poolState']} ${stateClassOf(latest.state)}`}><span className={styles['statusDot']} aria-hidden="true" />{stateTextOf(latest, t)}</span>
                    <ModelCell detail={latest} cache={latest.cache} t={t} />
                    <span className={styles['poolContext']}><time dateTime={new Date(time).toISOString()}>{formatTimeOfDay(time)}</time></span>
                  </div>
                  <div className={styles['requestMetrics']}>
                    <div>
                      <div className={styles['metricValue']}><HitCell cache={latest.cache} attribution={latest.compactionAttribution} t={t} /></div>
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
                      {showCacheWrite && <span>{t('pool.metric.cacheWrite')} <b>{tokenTextOf(latest.cacheWriteTokens)}</b></span>}
                    </div>
                    {/* The note lives in the footer's right slot — the same
                     * slot the buckets mirror — so the panel keeps one
                     * height whether a note exists or not. It is one line with
                     * an ellipsis; the full text is in the tooltip. */}
                    {notice !== undefined
                      ? (
                          <Tooltip label={notice.full} side="top" delayMs={100}>
                            <span className={noteClass} tabIndex={0}>{notice.text}</span>
                          </Tooltip>
                        )
                      : staleAt !== undefined
                        ? <span className={styles['poolContext']}>{t('pool.asOf', { time: formatTimeOfDay(staleAt) })}</span>
                        : null}
                  </div>
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
            <div ref={wrapRef} onScroll={handleWrapScroll} className={styles['poolTableWrap']} tabIndex={0} role="region" aria-label={t('pool.history.scroll')}>
              <table className={styles['poolTable']} aria-label={t('pool.title')} style={{ minWidth: `${colFloors.reduce((sum, width) => sum + width, 0)}px` }}>
                <colgroup>
                  {colFloors.map((width, index) => <col key={index} style={{ width }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th className={styles['poolModelHead']}>{t('pool.col.origin')}</th>
                    <th>{t('pool.col.state')}</th>
                    <th>{t('pool.col.time')}</th>
                    <th className={styles['poolModelHead']}>{t('pool.col.model')}</th>
                    <th>{t('pool.col.hit')}</th>
                    <th>{t('pool.col.input')}</th>
                    <th>{t('pool.col.output')}</th>
                    <th>{t('pool.col.cacheRead')}</th>
                    {showCacheWrite && <th>{t('pool.col.cacheWrite')}</th>}
                    <th>{t('pool.col.ttft')}</th>
                    <th>{t('pool.col.latency')}</th>
                    <th>{t('pool.col.speed')}</th>
                    <th>{t('pool.col.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(detail => <PoolRow key={detail.id} detail={detail} focusId={focusId} view={view} showCacheWrite={showCacheWrite} t={t} />)}
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
