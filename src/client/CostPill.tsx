/**
 * Composer-dock usage pill (browser half): a cost trigger registered into
 * the `conversation.composer.dock` slot (`order: 10`, after the official
 * stats pills at `order: 0`), rendered as one capsule in the official
 * StatsPills skin. The figure is the WITH-SUBAGENTS fold — the one number
 * no official surface carries — suffixed with a quiet "with subagents"
 * badge only when the scope actually spans a subtree; a solo session's
 * cost renders bare, same scope as the official pills beside it.
 *
 * Clicking opens a detail panel (harness menu chrome, upward of the dock)
 * that explains the total: the folded token figure and cache-hit rate next
 * to it (official pills carry only the single-session token count, so the
 * subtree share has no home but here), the session / subagents split, and
 * a per-model breakdown with the unpriced-models footnote. Panel data is
 * LAZY: the trigger polls `fields=chip` (totals only, subtree scope); the
 * two richer reads (`fields=session` for byModel, a solo-session `chip`
 * read for the split) fire when the panel first opens and again whenever
 * request churn debounces through.
 *
 * The pill refreshes at REQUEST granularity (the header chip's former
 * cadence, inherited whole): `sessionStats` projection churn plus mirror
 * `updatedAt` is debounced 250 ms into one fetch, a failed FIRST fetch
 * retries itself on a 3 s cadence, and later failures keep the prior
 * figures. When cost rises on a new request the figure plays `costPop`
 * and a +Δ label FALLS below the pill (the dock sits under the composer;
 * the header chip's upward rise would climb into the message scrollport).
 * Reduced-motion users get silent figure updates.
 *
 * Visibility contract: a session with no recorded requests renders
 * nothing; a transient fetch miss keeps the previous render.
 *
 * @module token-usage/client/CostPill
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges SessionStandardProps / GlobalStandardProps (`sessionId`,
// `useSessions`, `useProjection`) into the composer-dock runtime kit.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: merges the sessionStats key into SessionProjectionMap.
import type {} from '@deepseek-ai/dsh-session-stats/client'
// Type-only: pulls the `conversation.composer.dock` SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CostedModelRow, UsageSummary } from '../wire.ts'
import { STATS_PATH, encodeStatsQuery } from '../wire.ts'
import { useAsyncResource, useDebouncedValue } from './async-resource.ts'
import { totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatTokens, hitRateDisplay } from './format.ts'
import { buildChildIndex, buildStatsFreshnessKey, subtreeIds } from './session-stats.ts'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import { CostDeltaFlyLabel } from './CostDeltaFlyLabel.tsx'
import { useCostInflate } from './use-cost-inflate.ts'
import styles from './CostPill.module.css'

/** Refresh debounce: bursts of session-mirror updates (one request's events)
 * collapse into a single fetch — the header chip's request-scale cadence. */
const REFRESH_DEBOUNCE_MS = 250

/** Self-heal cadence after a failed first fetch: refresh failures after the
 * first land keep the prior figures (silent mode) and self-heal on the next
 * request churn, so they never reach the error state. */
export const FETCH_FAILURE_RETRY_MS = 3_000

/** Detail panel width (px); the viewport-clamped centering uses it. */
const PANEL_WIDTH = 300
const PANEL_VIEWPORT_MARGIN = 16

/** Props the pill binds for the composer-dock slot: the framework's session
 * kit (`sessionId` + the global `useSessions` mirror used to walk the
 * subagent tree) plus the locale seat from the registration's `locale:`
 * declaration. The dock slot declares no owner share. */
export type CostPillProps =
  PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'token-usage'>

/**
 * The session / subagents split of one folded summary. Subagent figures are
 * derived by subtraction (folded minus solo) and clamped at zero — a stale
 * solo read against a fresher fold must never paint a negative share.
 */
export interface UsageSplit {
  selfCost: number
  subsCost: number
  selfTokens: number
  subsTokens: number
}

/**
 * Subtract a solo-session summary from its subtree fold.
 * @param tree - the subtree-scoped folded summary.
 * @param self - the solo-session summary (same session, no children).
 * @returns the two shares; costs and tokens are additive so subtraction is
 * exact, and the hit rate is NEVER split (a ratio is not subtractable — the
 * panel recomputes the folded rate from the tree totals instead).
 */
export function splitUsage(tree: UsageSummary, self: UsageSummary): UsageSplit {
  const sub = (whole: number, part: number): number => (whole - part > 0 ? whole - part : 0)
  return {
    selfCost: self.totalCost,
    subsCost: sub(tree.totalCost, self.totalCost),
    selfTokens: totalTokens(self.total),
    subsTokens: sub(totalTokens(tree.total), totalTokens(self.total)),
  }
}

/**
 * Render the composer-dock usage pill for the active session. Renders
 * nothing when the session has no recorded usage or while the first fetch
 * is in flight — the "data has no value, the block does not render" rule.
 * @param props - framework session id, the session-list mirror, and the locale seat.
 * @returns the pill (plus its open detail panel), or null when empty/unavailable.
 */
export function CostPill({ sessionId, useSessions, useProjection, t }: CostPillProps): ReactNode | null {
  const rootRef = useRef<HTMLSpanElement>(null)
  const costRef = useRef<HTMLSpanElement>(null)
  useColorSchemeMirror(rootRef)
  const [open, setOpen] = useState(false)

  // Same membership as the Usage tab's "with subagents" scope: the active
  // session plus every origin=subagent descendant. An ordinary fork is not
  // a subagent and does not join the fold.
  const byId = useSessions(state => state.byId)
  const childIndex = useMemo(() => buildChildIndex(byId), [byId])
  const scopeIds = useMemo(
    () => (sessionId === '' ? [] : subtreeIds(byId, sessionId, childIndex)),
    [byId, sessionId, childIndex],
  )
  const hasSubs = scopeIds.length > 1
  const liveStats = useProjection('sessionStats')
  const freshnessKey = buildStatsFreshnessKey(scopeIds, {
    activeSessionId: sessionId,
    rows: byId,
    liveSessionStats: liveStats,
  })
  const requestKey = `${scopeIds.join('\n')}\n\t${freshnessKey}`
  const debouncedKey = useDebouncedValue(requestKey, REFRESH_DEBOUNCE_MS)
  const scopeResetKey = scopeIds.join('\n')
  const { flies, onSummary } = useCostInflate(scopeResetKey, costRef)

  // The trigger's poll: subtree totals only (`fields=chip`), the lightest
  // read that feeds cost / tokens / hit rate.
  const [treeRes, retryTree] = useAsyncResource<UsageSummary | null>(
    signal => {
      const [idsPart] = debouncedKey.split('\n\t')
      const ids = (idsPart ?? '').split('\n').filter(id => id !== '')
      return fetchSummary(ids, 'chip', signal)
    },
    [debouncedKey],
    { silentAfterFirst: true, retryToken: 0 },
  )
  const summary = treeRes.status === 'ready' ? treeRes.value : null

  useEffect(() => {
    if (summary !== null) onSummary(summary)
  }, [summary, onSummary])

  // A failed first fetch renders nothing and self-heals on the retry
  // cadence; later failures keep the prior render (silent mode).
  useEffect(() => {
    if (treeRes.status !== 'error') return
    const timer = window.setTimeout(retryTree, FETCH_FAILURE_RETRY_MS)
    return () => { window.clearTimeout(timer) }
  }, [treeRes, retryTree])

  // Panel reads, LAZY: nothing flies while the panel is closed. The detail
  // read (`fields=session`) carries byModel; the solo read splits the fold.
  // Both re-fire when request churn debounces through while open.
  const [detailRes] = useAsyncResource<UsageSummary | null>(
    signal => {
      if (!open) return Promise.resolve(null)
      const [idsPart] = debouncedKey.split('\n\t')
      const ids = (idsPart ?? '').split('\n').filter(id => id !== '')
      return fetchSummary(ids, 'session', signal)
    },
    [open, debouncedKey],
    { silentAfterFirst: true, retryToken: 0 },
  )
  const [selfRes] = useAsyncResource<UsageSummary | null>(
    signal => {
      if (!open || sessionId === '') return Promise.resolve(null)
      return fetchSummary([sessionId], 'chip', signal)
    },
    [open, sessionId, debouncedKey],
    { silentAfterFirst: true, retryToken: 0 },
  )

  // Session switches close the panel — the split it explains no longer holds.
  useEffect(() => {
    setOpen(false)
  }, [sessionId])

  // Outside pointer / Escape close — the harness popup pattern (ContextMeter
  // and the quota button share it), anchored while open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Center the panel on the pill, clamped to the viewport's margins (the
  // dock row is full-width, but a bare left:0 could still skew off-screen
  // on narrow windows). Measured at open, refreshed on resize while open.
  const [panelLeft, setPanelLeft] = useState<number | undefined>(undefined)
  const measurePanelLeft = useCallback((): void => {
    const wrapper = rootRef.current
    if (wrapper === null) return
    const { left: wrapperLeft, width: wrapperWidth } = wrapper.getBoundingClientRect()
    const panelWidth = Math.min(PANEL_WIDTH, window.innerWidth - 2 * PANEL_VIEWPORT_MARGIN)
    const desired = (wrapperWidth - panelWidth) / 2
    const minLeft = PANEL_VIEWPORT_MARGIN - wrapperLeft
    const maxLeft = window.innerWidth - PANEL_VIEWPORT_MARGIN - panelWidth - wrapperLeft
    setPanelLeft(Math.min(Math.max(desired, minLeft), Math.max(minLeft, maxLeft)))
  }, [])
  useEffect(() => {
    if (!open) return
    measurePanelLeft()
    window.addEventListener('resize', measurePanelLeft)
    return () => { window.removeEventListener('resize', measurePanelLeft) }
  }, [open, measurePanelLeft])

  if (summary === null || summary.total.requests === 0) return null

  const view = currencyViewOf(summary)
  const costText = formatCost(summary.totalCost, view)
  const tokensValue = formatTokens(totalTokens(summary.total))
  const hit = hitRateDisplay(summary.total)
  const ariaLabel = hasSubs
    ? t('pill.costWithSubs', { value: costText })
    : t('pill.cost', { value: costText })

  // Panel shares: the split waits on the solo read; per-model waits on the
  // detail read. While either is in flight its block shows a quiet ellipsis.
  const selfSummary = selfRes.status === 'ready' ? selfRes.value : null
  const detail = detailRes.status === 'ready' ? detailRes.value : null
  const split = selfSummary !== null ? splitUsage(summary, selfSummary) : null
  const subCount = scopeIds.length - 1

  return (
    <span ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}，${t('panel.openHint')}`}
        onClick={() => { setOpen(!open) }}
      >
        <svg className={styles.glyph} viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M4.8 4.5 L7 7.2 L9.2 4.5 M7 7.2 V10 M5.2 8 H8.8 M5.2 9.4 H8.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
        <span ref={costRef} className={styles.cost}>{costText}</span>
        <span className={styles.deltaLayer} aria-hidden="true">
          {flies.map(fly => (
            <CostDeltaFlyLabel key={fly.id} text={fly.text} vars={fly.vars} />
          ))}
        </span>
      </button>
      {open && (
        <span className={styles.panel} role="dialog" aria-label={t('panel.title')} style={{ left: panelLeft }}>
          <span className={styles.panelHead}>
            <span className={styles.panelTitle}>
              {t('panel.title')}
              {hasSubs && <span className={styles.scopeTag}>{t('pill.scopeTag')}</span>}
            </span>
            <span className={styles.panelTotal}>{costText}</span>
          </span>
          <span className={styles.usageLine}>
            <span>{t('panel.tokens', { value: tokensValue })}</span>
            <span className={styles.dot}>·</span>
            <span>{t('panel.hitRate', { value: hit.text })}</span>
          </span>
          <span className={styles.rows}>
            <span className={styles.row}>
              <span className={styles.rowLabel}>{t('panel.self')}</span>
              <span className={styles.rowValue}>
                {split === null
                  ? <span className={styles.pending}>…</span>
                  : <>{formatCost(split.selfCost, view)}<span className={styles.tok}>{t('panel.tokens', { value: formatTokens(split.selfTokens) })}</span></>}
              </span>
            </span>
            {hasSubs && (
              <span className={`${styles.row} ${styles.rowSub}`}>
                <span className={styles.rowLabel}>{t('panel.subs', { count: subCount })}</span>
                <span className={styles.rowValue}>
                  {split === null
                    ? <span className={styles.pending}>…</span>
                    : <>{formatCost(split.subsCost, view)}<span className={styles.tok}>{t('panel.tokens', { value: formatTokens(split.subsTokens) })}</span></>}
                </span>
              </span>
            )}
          </span>
          <span className={styles.groupLabel}>{t('panel.byModel')}</span>
          <span className={styles.rows}>
            {detail === null
              ? (
                  <span className={styles.row}>
                    <span className={styles.pending}>…</span>
                  </span>
                )
              : (
                  <>
                    {detail.byModel.map(row => (
                      <ModelRow key={row.model} row={row} view={view} />
                    ))}
                    {detail.unpricedModels.length > 0 && (
                      <span className={`${styles.row} ${styles.unpriced}`}>
                        <span className={styles.rowLabel}>{t('panel.unpriced', { count: detail.unpricedModels.length })}</span>
                        <span className={styles.rowValue}>{t('panel.unpricedNote')}</span>
                      </span>
                    )}
                  </>
                )}
          </span>
        </span>
      )}
    </span>
  )
}

/** One per-model breakdown row: model id + request count, billed cost, tokens. */
function ModelRow({ row, view }: { row: CostedModelRow; view: ReturnType<typeof currencyViewOf> }): ReactNode {
  return (
    <span className={styles.row}>
      <span className={styles.rowLabel}>
        {row.model}
        <span className={styles.requests}>× {row.totals.requests}</span>
      </span>
      <span className={styles.rowValue}>
        {formatCost(row.cost, view)}
        <span className={styles.tok}>{formatTokens(totalTokens(row.totals))}</span>
      </span>
    </span>
  )
}

/** Defensive shape check: an older host build or a misrouted response
 * would otherwise paint the pill with garbage. */
function looksLikeUsageSummary(value: unknown): value is UsageSummary {
  return typeof value === 'object' && value !== null
    && typeof (value as { total?: unknown }).total === 'object'
    && (value as { total?: unknown }).total !== null
}

/**
 * Fetch one stats summary. Throws on transport failure (network, abort,
 * non-2xx response, or a payload that doesn't look like a stats summary) so
 * the hook can keep the previous render in place.
 * @param sessionIds - the scope's session ids; an empty list skips the
 * fetch (returning null rather than throwing, so the hook's first-load
 * gate stays at "loading").
 * @param fields - `chip` for totals-only reads, `session` when byModel is
 * needed (the detail panel's per-model block).
 * @param signal - the cancellation signal from the hook.
 */
async function fetchSummary(
  sessionIds: readonly string[],
  fields: 'chip' | 'session',
  signal: AbortSignal,
): Promise<UsageSummary | null> {
  if (sessionIds.length === 0) return null
  const response = await fetch(STATS_PATH + encodeStatsQuery({ sessionIds, fields }), {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value: unknown = await response.json()
  if (!looksLikeUsageSummary(value)) throw new Error('unexpected stats response')
  return value
}
