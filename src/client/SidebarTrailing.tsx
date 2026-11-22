/**
 * Sidebar trailing badge (browser half): the live "today" figure parked at
 * the end of the pinned Token Usage row, registered into
 * `sidebar.panellist.trailing` with the panel id `token-usage`.
 *
 * The row itself belongs to ui-sidebar; this component only supplies the
 * inline content the shell lays out after the title (expanded) or over the
 * icon's top trailing corner (collapsed). It is display-only by contract:
 * no interactive elements, and the decorative separator is hidden from the
 * accessibility tree while the figures stay readable as part of the row's
 * accessible name.
 *
 * Scope: the WHOLE log bounded to today (local day), not a session and not
 * the historical total — the figure answers "how much today", which is what
 * the navigation row is for. The read is the totals-only `fields=chip` face,
 * refreshed on a slow cadence and when the page becomes visible again.
 *
 * @module token-usage/client/SidebarTrailing
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CurrencyView } from './format.ts'
import { STATS_PATH, encodeStatsQuery } from '../wire.ts'
import type { WholeChipSummary } from '../wire.ts'
import { useAsyncResource } from './async-resource.ts'
import { dayKeyOf, totalTokens } from './day.ts'
import { currencyViewOf, formatCost, formatTokens } from './format.ts'
import { costsAvailable } from './PricingStatus.tsx'
import styles from './SidebarTrailing.module.css'

/** Refresh cadence: the badge is ambient, not a dashboard. Request events
 * already land through other surfaces; one minute keeps the figure honest
 * without polling the stats fold on every paint. */
export const TRAILING_REFRESH_MS = 60_000

/** First-read failure retry: short, so a transient host startup miss heals
 * without the user toggling anything. Later failures keep the last render. */
export const TRAILING_FAILURE_RETRY_MS = 15_000

/** Props the badge binds: the owner's row state plus the framework kit. */
export type SidebarTrailingProps = PropsRuntime<'sidebar.panellist.trailing'>

/**
 * Render the today figure for the pinned Token Usage row.
 * @param props - `wide` says whether the sidebar is expanded; the collapsed
 * rail leaves room for a cost mark only.
 * @returns the inline figure, or null while the first read is in flight /
 * when today has no recorded requests.
 */
export function SidebarTrailing({ wide }: SidebarTrailingProps): ReactNode | null {
  const [tick, setTick] = useState(0)

  // Slow ambient cadence plus an immediate catch-up when the tab returns:
  // a hidden tab's timer may have been throttled, so the visible flip is the
  // reliable refresh point.
  useEffect(() => {
    const timer = window.setInterval(() => { setTick(value => value + 1) }, TRAILING_REFRESH_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') setTick(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const [result, retry] = useAsyncResource<WholeChipSummary | null>(
    signal => fetchToday(signal),
    [tick],
    { silentAfterFirst: true, retryToken: 0 },
  )

  useEffect(() => {
    if (result.status !== 'error') return
    const timer = window.setTimeout(retry, TRAILING_FAILURE_RETRY_MS)
    return () => { window.clearTimeout(timer) }
  }, [result, retry])

  const summary = result.status === 'ready' ? result.value : null
  // No recorded request today means no value to show; the row stays clean
  // rather than parking a meaningless zero beside the title.
  if (summary === null || summary.total.requests === 0) return null

  const view = currencyViewOf(summary)
  const priced = costsAvailable(summary.costState)

  // The collapsed rail places the content over the icon's top trailing
  // corner (a few pixels wide), so it carries the cost only, in its
  // shortest form; the token figure waits for the expanded row.
  if (!wide) {
    return <span className={styles.rail}>{priced ? shortCost(summary.totalCost, view) : '—'}</span>
  }

  return (
    <span className={styles.wide}>
      <span className={styles.cost}>{priced ? formatCost(summary.totalCost, view) : '—'}</span>
      <span className={styles.separator} aria-hidden="true">·</span>
      <span className={styles.tokens}>{formatTokens(totalTokens(summary.total))}</span>
    </span>
  )
}

/**
 * The collapsed rail's cost mark: no decimals above ten units, one decimal
 * below, keeping the symbol on the same trailing side as {@link formatCost}.
 * @param cost - the RMB amount from the wire.
 * @param view - the display currency view.
 */
export function shortCost(cost: number, view: CurrencyView): string {
  const converted = cost / view.rate
  if (converted >= 10) return `${String(Math.round(converted))}${view.symbol}`
  const oneDecimal = converted.toFixed(1)
  return `${oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal}${view.symbol}`
}

/** Defensive shape check: an older host or a misrouted response would
 * otherwise paint the row with garbage. */
function looksLikeWholeChip(value: unknown): value is WholeChipSummary {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { scope?: unknown; total?: unknown; totalCost?: unknown; currency?: unknown }
  return candidate.scope === 'whole'
    && typeof candidate.total === 'object' && candidate.total !== null
    && typeof candidate.totalCost === 'number'
    && (candidate.currency === 'CNY' || candidate.currency === 'USD')
}

/**
 * Read today's whole-log totals through the totals-only chip face.
 * @param signal - the hook's cancellation signal.
 * @returns the chip payload; throws so the hook keeps the prior render.
 */
async function fetchToday(signal: AbortSignal): Promise<WholeChipSummary | null> {
  const today = dayKeyOf(new Date())
  const response = await fetch(STATS_PATH + encodeStatsQuery({ from: today, to: today, fields: 'chip' }), {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value: unknown = await response.json()
  if (!looksLikeWholeChip(value)) throw new Error('unexpected stats response')
  return value
}