/**
 * The settings page's per-session detail table (browser half): the "by
 * session" mode of the detail-table block. Rows arrive FINAL from the host
 * route — folded over subagent subtrees (a subagent's only visibility here
 * is the row's child-count badge; the conversation view's subagent table
 * owns the per-child drill-down), cost-sorted, top-N truncated, with the
 * metadata index's titles and directories attached — so this component only
 * re-organizes presentation: the optional directory grouping (default on,
 * session-local, no request; grouped rows indent under their directory
 * head) and the identity fallback for titleless sessions (short id + time
 * span; the plugin never fabricates a title). Rows carry no click behavior,
 * matching the per-model table.
 *
 * @module token-usage/client/SessionTable
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionUsageRow } from '../wire.ts'
import { dayKeyOf, totalTokens } from './day.ts'
import type { CurrencyView } from './format.ts'
import { formatCost, formatTokens } from './format.ts'
import { RequestsCell, RequestsSplitHead } from './StatCard.tsx'
import styles from './SessionTable.module.css'

/** The last path segment of a directory, on either separator. */
function dirTailOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/u).filter(part => part !== '')
  return parts[parts.length - 1] ?? cwd
}

/** A short session-id fallback: the leading chunk is usually enough to
 * tell sessions apart when no title ever landed. */
function shortIdOf(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

/** The columns whose headers sort the table, and the row value each reads. */
type SortKey = 'tokens' | 'cost' | 'lastTime'

function sortValueOf(row: SessionUsageRow, key: SortKey): number {
  if (key === 'tokens') return totalTokens(row.totals)
  if (key === 'cost') return row.cost
  return row.lastTime
}

/** Sort state cycle: first click descending (usage reads big-first), second
 * click ascending, third click back to the server's cost-descending order.
 * Presentation-only — the rows in hand are already the final top-N fold. */
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null

function nextSort(current: SortState, key: SortKey): SortState {
  if (current?.key !== key) return { key, dir: 'desc' }
  if (current.dir === 'desc') return { key, dir: 'asc' }
  return null
}

/**
 * Render the session table: the grouping switch above the table, optional
 * directory groups (rows indent under their group head), one row per
 * served session. The token / cost / last-active headers sort the rows
 * client-side within the served set (groups keep their directory order;
 * rows reorder inside each group).
 * @param props - the served rows, the currency view, locale.
 */
export function SessionTable({ rows, view, t }: {
  rows: readonly SessionUsageRow[]
  view: CurrencyView
  t: TranslateNS<'token-usage'>
}): ReactNode {
  // Directory grouping: presentation-only (rows already carry their cwd),
  // default on, session-local like the usage tab's switches — never
  // persisted, never a request.
  const [grouped, setGrouped] = useState(true)
  const [sort, setSort] = useState<SortState>(null)
  const sorted = useMemo(() => {
    if (sort === null) return rows
    const factor = sort.dir === 'desc' ? -1 : 1
    return [...rows].sort((left, right) =>
      factor * (sortValueOf(left, sort.key) - sortValueOf(right, sort.key))
      || (left.sessionId < right.sessionId ? -1 : 1))
  }, [rows, sort])
  const groups = useMemo(() => {
    if (!grouped) return null
    const map = new Map<string, SessionUsageRow[]>()
    for (const row of sorted) {
      const key = row.cwd ?? ''
      const bucket = map.get(key) ?? []
      bucket.push(row)
      map.set(key, bucket)
    }
    // Directories by name; the no-directory group sinks to the end.
    return [...map.entries()].sort((left, right) => {
      if (left[0] === '') return 1
      if (right[0] === '') return -1
      return left[0].localeCompare(right[0])
    })
  }, [sorted, grouped])

  /** One sortable header cell: the column name as the toggle, the current
   * direction marked and announced via aria-sort. */
  const sortHead = (key: SortKey, label: string): ReactNode => {
    const active = sort?.key === key
    return (
      <th {...active ? { 'aria-sort': sort!.dir === 'desc' ? 'descending' : 'ascending' } : {}}>
        <button
          type="button"
          className={styles['sortBtn']}
          onClick={() => setSort(previous => nextSort(previous, key))}
        >
          {label}
          {active ? <span className={styles['sortMark']}>{sort!.dir === 'desc' ? '▼' : '▲'}</span> : null}
        </button>
      </th>
    )
  }

  return (
    <>
      <div className={styles['head']}>
        <div className={styles['segmented']} role="group" aria-label={t('session.group.label')}>
          <button
            type="button"
            className={grouped ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
            aria-pressed={grouped}
            onClick={() => setGrouped(true)}
          >
            {t('session.group.on')}
          </button>
          <button
            type="button"
            className={!grouped ? `${styles['segBtn']} ${styles['segActive']}` : styles['segBtn']}
            aria-pressed={!grouped}
            onClick={() => setGrouped(false)}
          >
            {t('session.group.off')}
          </button>
        </div>
      </div>
      <div className={styles['tableWrap']}>
        <table className={styles['table']} aria-label={t('bySession.title')}>
          <thead>
            <tr>
              <th className={styles['sessionHead']}>{t('session.titleCol')}</th>
              <th aria-label={t('stat.successFail')}><RequestsSplitHead t={t} /></th>
              {sortHead('tokens', t('stat.totalTokens'))}
              {sortHead('cost', t('stat.cost'))}
              {sortHead('lastTime', t('session.lastActive'))}
            </tr>
          </thead>
          <tbody>
            {groups === null
              ? sorted.map(row => renderRow(row, false))
              : groups.map(([cwd, groupRows]) => (
                <FragmentGroup key={cwd === '' ? '\u0000' : cwd} cwd={cwd} count={groupRows.length} t={t}>
                  {groupRows.map(row => renderRow(row, true))}
                </FragmentGroup>
              ))}
          </tbody>
        </table>
      </div>
    </>
  )

  function renderRow(row: SessionUsageRow, indented: boolean): ReactNode {
    // Identity: the log-backed title when one landed; otherwise the short
    // session id plus the time span (the span substitutes for the missing
    // title, it never pretends to be one). The directory tail rides along
    // as the secondary identity only in the ungrouped list — grouped, it
    // lives in the group head.
    return (
      <tr key={row.sessionId}>
        <td className={indented ? `${styles['sessionCol']} ${styles['sessionIndent']}` : styles['sessionCol']}>
          <span className={styles['sessionCell']}>
            <span className={styles['sessionName']}>
              {row.title !== undefined
                ? row.title
                : `${shortIdOf(row.sessionId)} · ${dayKeyOf(new Date(row.firstTime))} – ${dayKeyOf(new Date(row.lastTime))}`}
            </span>
            {row.childCount !== undefined && row.childCount > 0
              ? (
                <span
                  className={styles['badge']}
                  aria-label={t('view.subagents.nested', { count: String(row.childCount) })}
                >
                  {t('view.subagents.nested', { count: String(row.childCount) })}
                </span>
              )
              : null}
          </span>
          {!indented && row.cwd !== undefined
            ? <span className={styles['dirTail']}>{dirTailOf(row.cwd)}</span>
            : null}
        </td>
        <td>
          <RequestsCell
            requests={row.totals.requests}
            failures={row.totals.failures ?? 0}
            failuresByCode={row.totals.failuresByCode}
            t={t}
          />
        </td>
        <td>{formatTokens(totalTokens(row.totals))}</td>
        <td>{formatCost(row.cost, view)}</td>
        <td>{dayKeyOf(new Date(row.lastTime))}</td>
      </tr>
    )
  }
}

/** One directory group: a full-width head row with the directory tail, then
 * the group's rows (a keyed fragment keeps `<tr>`s table-legal). */
function FragmentGroup({ cwd, count, t, children }: {
  cwd: string
  count: number
  t: TranslateNS<'token-usage'>
  children: ReactNode
}): ReactNode {
  return (
    <>
      <tr className={styles['groupRow']}>
        <td colSpan={5} className={styles['groupHead']}>
          {cwd === '' ? t('session.untitledDir') : dirTailOf(cwd)}
          <span className={styles['groupCount']}>{String(count)}</span>
        </td>
      </tr>
      {children}
    </>
  )
}
