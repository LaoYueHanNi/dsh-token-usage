/**
 * Session-header stats chip (browser half): a one-line compact strip rendered
 * into the `conversation.session.header.utilities` slot — three sub-chips
 * (total tokens / cache hit rate / session cost) beside the Session log
 * button. Data comes from `/token-usage/stats?fields=chip` scoped to the
 * active session and its subagent subtree (the Usage tab's "with
 * subagents" range), so a parent that spawned children shows the same
 * folded numbers the header is meant to summarise. Numbers refresh at
 * REQUEST granularity (same cadence as the Usage tab): `sessionStats`
 * projection churn (plus mirror `updatedAt` when present) is debounced
 * into one fetch, so idle sessions do not poll and a finished request
 * updates the header within ~250 ms. When cost
 * rises on a new request, the cost cell plays `costPop` (scale bounce) and
 * `deltaRise` (+Δ fly); reduced-motion users get silent figure updates
 * instead. A failed FIRST fetch retries itself on a 3 s cadence — the old
 * poll's safety net — so an idle-but-used session still gets its chip.
 *
 * Visibility contract: a session with no recorded requests renders nothing
 * (an empty header strip is worse than no strip; the chip never blanks to
 * "—"). Hit-rate colour is the four-bucket mapping in `format.hitRateDisplay`:
 * ≥95% healthy (green), 80–95% lime, 60–80% amber, below 60% critical (red).
 * Amber/lime fill the warm→cool gap so the four stops read as one progression.
 *
 * @module token-usage/client/SessionStatsChip
 */

import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges SessionStandardProps / GlobalStandardProps (`sessionId`,
// `useSessions`, `useProjection`) into the header-utilities runtime kit
// (the kit's declaration lives in ui-session since dsh-client-runtime was
// removed).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: merges the sessionStats key into SessionProjectionMap.
import type {} from '@deepseek-ai/dsh-session-stats/client'
// Type-only: pulls the `conversation.session.header.utilities` SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UsageSummary } from '../wire.ts'
import { encodeStatsQuery, STATS_PATH } from '../wire.ts'
import { useAsyncResource, useDebouncedValue } from './async-resource.ts'
import { totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatTokens, hitRateDisplay } from './format.ts'
import { HitRateText } from './HitRateText.tsx'
import { buildChildIndex, buildStatsFreshnessKey, subtreeIds } from './session-stats.ts'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import { CostDeltaFlyLabel } from './CostDeltaFlyLabel.tsx'
import { useCostInflate } from './use-cost-inflate.ts'
import styles from './SessionStatsChip.module.css'

/** Refresh debounce: bursts of session-mirror updates (one request's events)
 * collapse into a single fetch, matching the Usage tab's request-scale
 * cadence instead of a steady poll. */
const REFRESH_DEBOUNCE_MS = 250

/** Self-heal cadence after a failed first fetch. With the poll gone, this
 * retry is the only thing that recovers an idle session's chip: refresh
 * failures after the first land keep the prior figures (silent mode) and
 * self-heal on the next request churn, so they never reach the error state. */
export const FETCH_FAILURE_RETRY_MS = 3_000

/** Props the chip binds for the conversation-session header utilities slot:
 * the framework's session kit (`sessionId` + the global `useSessions`
 * mirror used to walk the subagent tree) plus the locale seat from the
 * registration's `locale:` declaration. */
export type SessionStatsChipProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'token-usage'>

/**
 * Render the session-header stats chip for the active session. Renders
 * nothing when the session has no recorded usage, when the fetch fails, or
 * while the first fetch is in flight — the spec's "data has no value, the
 * block does not render" rule.
 * @param props - framework session id, the session-list mirror, and the locale seat.
 * @returns the chip strip, or null when the data is empty/unavailable.
 */
export function SessionStatsChip({ sessionId, useSessions, useProjection, t }: SessionStatsChipProps): ReactNode | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const costRef = useRef<HTMLSpanElement>(null)
  useColorSchemeMirror(rootRef)
  const byId = useSessions(state => state.byId)
  const childIndex = useMemo(() => buildChildIndex(byId), [byId])
  // Same membership as the Usage tab's "with subagents" scope: the active
  // session plus every origin=subagent descendant. An ordinary fork is not
  // a subagent and does not join the fold.
  const scopeIds = useMemo(
    () => (sessionId === '' ? [] : subtreeIds(byId, sessionId, childIndex)),
    [byId, sessionId, childIndex],
  )
  const liveStats = useProjection('sessionStats')
  // Debounce on scope membership + sessionStats churn (and updatedAt when
  // present). sessionStats bumps every finished request; updatedAt alone
  // does not — same fix as the Usage tab's token/cost refresh.
  const freshnessKey = buildStatsFreshnessKey(scopeIds, {
    activeSessionId: sessionId,
    rows: byId,
    liveSessionStats: liveStats,
  })
  const requestKey = `${scopeIds.join('\n')}\n\t${freshnessKey}`
  const debouncedKey = useDebouncedValue(requestKey, REFRESH_DEBOUNCE_MS)
  const scopeResetKey = scopeIds.join('\n')
  const {
    flies,
    flyOverflow,
    onSummary,
  } = useCostInflate(scopeResetKey, costRef)
  const [resource, retry] = useAsyncResource<UsageSummary | null>(
    signal => {
      const [idsPart] = debouncedKey.split('\n\t')
      const sessionIds = (idsPart ?? '').split('\n').filter(id => id !== '')
      return fetchSessionSummary(sessionIds, signal)
    },
    [debouncedKey],
    { silentAfterFirst: true, retryToken: 0 },
  )

  // The spec's empty rule: a session with no fetched summary, with zero
  // requests, or still on the first attempt renders nothing.
  const summary = resource.status === 'ready' ? resource.value : null

  useEffect(() => {
    if (summary !== null) onSummary(summary)
  }, [summary, onSummary])

  // A failed first fetch renders nothing and, unlike the old poll, no later
  // tick re-triggers it — schedule the resource hook's retry until data
  // lands. Keyed on the resource object: each fresh error reschedules.
  useEffect(() => {
    if (resource.status !== 'error') return
    const timer = window.setTimeout(retry, FETCH_FAILURE_RETRY_MS)
    return () => { window.clearTimeout(timer) }
  }, [resource, retry])

  if (summary === null || summary.total.requests === 0) return null

  const view = currencyViewOf(summary)
  const { total } = summary
  const tokensText = formatTokens(totalTokens(total))
  const hitText = hitRateDisplay(total).text
  const costText = formatCost(summary.totalCost, view)

  return (
    <div
      ref={rootRef}
      className={`${styles['strip']}${flyOverflow ? ` ${styles['stripFlyOverflow']}` : ''}`}
      role="group"
      aria-label={t('view.usage')}
    >
      <span
        className={styles['cell']}
        aria-label={t('chip.tokens', { value: tokensText })}
      >
        {tokensText}
      </span>
      {/* Hit-rate colour lives on an INNER span (`HitRateText`), not on the
          cell itself: `.cell` sets `color: label-primary`, and after the
          band classes moved into a shared CSS module the cell rule can
          land later in the bundle and override a same-element band class.
          Nesting keeps the bucket colour winning the same way the Usage /
          settings cards do. */}
      <span
        className={`${styles['cell']} ${styles['cellHit']}`}
        aria-label={t('chip.hitRate', { value: hitText })}
      >
        <HitRateText totals={total} />
      </span>
      <span
        className={`${styles['cell']} ${styles['costCell']}`}
        aria-label={t('chip.cost', { value: costText })}
      >
        <span ref={costRef} className={styles['costInner']}>
          {costText}
        </span>
        <span className={styles['deltaLayer']} aria-hidden="true">
          {flies.map(fly => (
            <CostDeltaFlyLabel key={fly.id} text={fly.text} vars={fly.vars} />
          ))}
        </span>
      </span>
    </div>
  )
}

/** Defensive shape check: an older host build or a misrouted response
 * would otherwise paint the header chip with garbage. */
function looksLikeUsageSummary(value: unknown): value is UsageSummary {
  return typeof value === 'object' && value !== null
    && typeof (value as { total?: unknown }).total === 'object'
    && (value as { total?: unknown }).total !== null
}

/**
 * Fetch the summary scoped to one session and its subagent subtree. Throws
 * on transport failure (network, abort, non-2xx response, or a payload
 * that doesn't look like a stats summary) so the hook can keep the
 * previous render in place — a transient miss never blanks the chip. The
 * hook's `silentAfterFirst` flag is what suppresses the resulting error
 * state.
 * @param sessionIds - the active session plus its subagent descendants;
 * an empty list skips the fetch (returning null rather than throwing, so
 * the hook's first-load gate stays at "loading").
 * @param signal - the cancellation signal from the hook.
 */
async function fetchSessionSummary(
  sessionIds: readonly string[],
  signal: AbortSignal,
): Promise<UsageSummary | null> {
  if (sessionIds.length === 0) return null
  const response = await fetch(STATS_PATH + encodeStatsQuery({ sessionIds, fields: 'chip' }), {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value: unknown = await response.json()
  if (!looksLikeUsageSummary(value)) throw new Error('unexpected stats response')
  return value
}
