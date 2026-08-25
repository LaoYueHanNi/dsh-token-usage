/**
 * Session-header stats chip (browser half): a one-line compact strip rendered
 * into the `conversation.session.header.utilities` slot — three sub-chips
 * (total tokens / cache hit rate / session cost) beside the Session log
 * button. Data comes from `/token-usage/stats?fields=chip` scoped to the
 * active session and its subagent subtree (the Usage tab's "with
 * subagents" range), so a parent that spawned children shows the same
 * folded numbers the header is meant to summarise. Numbers refresh on a
 * 3 s poll (conversation-scale, not request-scale): a new request only
 * nudges one of three figures by a single call's worth, and the host
 * cache makes each poll a memory hit unless today's file grew.
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
// `useSessions`) into the header-utilities runtime kit this file binds.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `conversation.session.header.utilities` SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UsageSummary } from '../wire.ts'
import { encodeStatsQuery, STATS_PATH } from '../wire.ts'
import { useAsyncResource } from './async-resource.ts'
import { totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatTokens, hitRateDisplay } from './format.ts'
import { HitRateText } from './HitRateText.tsx'
import { buildChildIndex, subtreeIds } from './session-stats.ts'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import styles from './SessionStatsChip.module.css'

/** The polling cadence for one session's summary (ms). Long enough that a
 * busy session does not turn the header into a fetcher; short enough that a
 * user reading the numbers sees a fresh value before they look away. */
const POLL_INTERVAL_MS = 3_000

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
export function SessionStatsChip({ sessionId, useSessions, t }: SessionStatsChipProps): ReactNode | null {
  const rootRef = useRef<HTMLDivElement>(null)
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
  const scopeKey = scopeIds.join('\n')
  // The hook drives every fetch; the surrounding interval just bumps the
  // retry counter on a steady tick. `silentAfterFirst: true` keeps the
  // prior chip on screen during a transient failure. `scopeKey` (not just
  // sessionId) retriggers when a child is spawned, so the next poll does
  // not have to wait 3 s to pick up the new id.
  const [resource, retry] = useAsyncResource<UsageSummary | null>(
    signal => fetchSessionSummary(scopeIds, signal),
    [scopeKey],
    { silentAfterFirst: true, retryToken: 0 },
  )
  useEffect(() => {
    if (sessionId === '') return
    const timer = setInterval(retry, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [sessionId, retry])

  // The spec's empty rule: a session with no fetched summary, with zero
  // requests, or still on the first attempt renders nothing.
  const summary = resource.status === 'ready' ? resource.value : null
  if (summary === null || summary.total.requests === 0) return null

  const view = currencyViewOf(summary)
  const { total } = summary
  const tokensText = formatTokens(totalTokens(total))
  const hitText = hitRateDisplay(total).text
  const costText = formatCost(summary.totalCost, view)

  return (
    <div ref={rootRef} className={styles['strip']} role="group" aria-label={t('view.usage')}>
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
        className={styles['cell']}
        aria-label={t('chip.cost', { value: costText })}
      >
        {costText}
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
