/**
 * The runtime-overhead card's row shape (browser half): one expanded-by-
 * default row per auxiliary kind — the row carries the kind's aggregate
 * (calls · cost · tokens) and discloses its per-model lines on toggle — plus
 * one expanded-by-default web-tools row that carries the total call count and
 * discloses its per-tool lines (`web_search`, `web_fetch`) on toggle. The
 * total line beneath the list covers the auxiliary kinds only: web tools
 * never join it, and any tokens a search reported are billed with the
 * ordinary request totals.
 *
 * @module token-usage/client/OverheadRows
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuxKind, AuxSummary, CostState, WebSearchSummary } from '../wire.ts'
import { costsAvailable } from './PricingStatus.tsx'
import { totalTokens } from './day.ts'
import type { CurrencyView } from './format.ts'
import { auxCallCount, formatCost, formatTokens } from './format.ts'
import list from './UsageRows.module.css'
import styles from './OverheadRows.module.css'

/**
 * Render the overhead rows: one disclosure row per auxiliary kind, the
 * web-search row, then the auxiliary total line. A summary without auxiliary
 * requests — including an older host payload with no `aux` field at all —
 * renders the empty hint instead, unless the web-search layer has calls.
 * A web row renders one line: its call count.
 * @param props - the aux layer (possibly absent), the web-search layer
 *   (absent on legacy payloads), the cost state, the display currency view,
 *   and the locale translator.
 */
export function OverheadRows({ aux, web, costState, view, t }: {
  aux: AuxSummary | undefined
  web?: WebSearchSummary | undefined
  costState: CostState
  view: CurrencyView
  t: TranslateNS<'token-usage'>
}): ReactNode {
  // Which kinds are collapsed — inverted so the default is every kind
  // expanded (the user's pick): the aggregate row AND its per-model lines
  // show at once, a toggle folds the drill-in away. Each kind toggles
  // independently; switching tabs unmounts the section, which is the
  // natural reset. New kinds arriving on a refresh default to expanded.
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<AuxKind>>(() => new Set())
  const [webCollapsed, setWebCollapsed] = useState(false)
  const toggleKind = (auxKind: AuxKind): void => {
    setCollapsedKinds(previous => {
      const next = new Set(previous)
      if (next.has(auxKind)) next.delete(auxKind)
      else next.add(auxKind)
      return next
    })
  }
  const hasAux = aux !== undefined && auxCallCount(aux.total) > 0
  const hasWeb = web !== undefined && web.calls > 0
  if (!hasAux && !hasWeb) {
    return <p className={styles['muted']}>{t('aux.empty')}</p>
  }
  const costText = (cost: number): string =>
    costsAvailable(costState) ? formatCost(cost, view) : '—'
  /** One drill-in line: model name ↔ calls · cost · tokens. */
  const modelLine = (model: string, requests: number, cost: number, tokens: number): ReactNode => (
    <span className={styles['dline']}>
      <span className={styles['dmodelName']}>{model}</span>
      <span>
        {t('aux.requestCount', { count: requests.toLocaleString() })}
        {' · '}
        {costText(cost)}
        {' · '}
        {formatTokens(tokens)}
      </span>
    </span>
  )
  return (
    <>
      <div className={list['rows']} role="list" aria-label={t('aux.tab')}>
        {(aux?.byKind ?? []).map(kindRow => {
          const expanded = !collapsedKinds.has(kindRow.auxKind)
          return (
            <div className={styles['orow']} role="listitem" key={kindRow.auxKind}>
              <div className={styles['orowTop']}>
                {/* The kind row is the parent aggregate AND its own
                 * disclosure toggle: chevron + category name in one
                 * button (`aria-expanded` carries the state). */}
                <button
                  type="button"
                  className={styles['kindToggle']}
                  aria-expanded={expanded}
                  onClick={() => toggleKind(kindRow.auxKind)}
                >
                  <span className={styles['chevron']} aria-hidden="true">▸</span>
                  {t(`aux.kind.${kindRow.auxKind}`)}
                </button>
                <span className={styles['onums']}>
                  {t('aux.requestCount', { count: auxCallCount(kindRow.totals).toLocaleString() })}
                  {' · '}
                  <span className={styles['onumsCost']}>{costText(kindRow.cost)}</span>
                  {' · '}
                  {formatTokens(totalTokens(kindRow.totals))}
                </span>
              </div>
              {expanded
                ? (
                  <div className={styles['adetail']}>
                    {(kindRow.byModel ?? []).map(modelRow => (
                      <span key={`${kindRow.auxKind}:${modelRow.model}`}>
                        {modelLine(modelRow.model, auxCallCount(modelRow.totals), modelRow.cost, totalTokens(modelRow.totals))}
                      </span>
                    ))}
                  </div>
                )
                : null}
            </div>
          )
        })}
        {hasWeb
          ? (
            <div className={styles['orow']} role="listitem" key="web-tools">
              <div className={styles['orowTop']}>
                <button
                  type="button"
                  className={styles['kindToggle']}
                  aria-expanded={!webCollapsed}
                  onClick={() => setWebCollapsed(previous => !previous)}
                >
                  <span className={styles['chevron']} aria-hidden="true">▸</span>
                  {t('web.title')}
                </button>
                <span className={styles['onums']}>
                  {t('web.calls', { count: web.calls.toLocaleString() })}
                </span>
              </div>
              {!webCollapsed && (web.byTool?.length ?? 0) > 0
                ? (
                  <div className={styles['adetail']}>
                    {(web.byTool ?? []).map(toolRow => (
                      <span key={`web:${toolRow.tool}`} className={styles['dline']}>
                        <span className={styles['dmodelName']}>{t(`web.tool.${toolRow.tool}`)}</span>
                        <span>{t('web.calls', { count: toolRow.calls.toLocaleString() })}</span>
                      </span>
                    ))}
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>
      {hasAux
        ? (
          <div className={styles['asum']}>
            <span>{t('aux.totalCount', { count: auxCallCount(aux.total).toLocaleString() })}</span>
            <span>
              <span className={styles['onumsCost']}>{costText(aux.cost)}</span>
              {' · '}
              {formatTokens(totalTokens(aux.total))}
            </span>
          </div>
        )
        : null}
    </>
  )
}
