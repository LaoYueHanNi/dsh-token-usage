/**
 * The runtime-overhead card's row shape (browser half): one expanded-by-
 * default row per auxiliary kind — the row carries the kind's aggregate
 * (calls · cost · tokens) and discloses its per-model lines on toggle; the
 * total line sits beneath the list. The semantics are the retired table's
 * (same fold, same empty hints, same defensive read of a payload without
 * `aux`); only the shape moved from columns to rows.
 *
 * @module token-usage/client/OverheadRows
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuxKind, AuxSummary, CostState } from '../wire.ts'
import { costsAvailable } from './PricingStatus.tsx'
import { totalTokens } from './day.ts'
import type { CurrencyView } from './format.ts'
import { formatCost, formatTokens } from './format.ts'
import list from './UsageRows.module.css'
import styles from './OverheadRows.module.css'

/**
 * Render the overhead rows: one disclosure row per kind, then the total
 * line. A summary without auxiliary requests — including an older host
 * payload with no `aux` field at all — renders the empty hint instead, so
 * the card keeps a stable body.
 * @param props - the aux layer of the summary (possibly absent), the cost
 * state, the display currency view, and the locale translator.
 */
export function OverheadRows({ aux, costState, view, t, compact = false }: {
  aux: AuxSummary | undefined
  costState: CostState
  view: CurrencyView
  t: TranslateNS<'token-usage'>
  compact?: boolean
}): ReactNode {
  // Which kinds are collapsed — inverted so the default is every kind
  // expanded (the user's pick): the aggregate row AND its per-model lines
  // show at once, a toggle folds the drill-in away. Each kind toggles
  // independently; switching tabs unmounts the section, which is the
  // natural reset. New kinds arriving on a refresh default to expanded.
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<AuxKind>>(() => new Set())
  const toggleKind = (auxKind: AuxKind): void => {
    setCollapsedKinds(previous => {
      const next = new Set(previous)
      if (next.has(auxKind)) next.delete(auxKind)
      else next.add(auxKind)
      return next
    })
  }
  if (aux === undefined || aux.total.requests === 0) {
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
  const content = (
    <>
      <div className={compact ? `${list['rows']} ${list['rowsCompact']}` : list['rows']} role="list" aria-label={t('aux.tab')}>
        {(aux.byKind ?? []).map(kindRow => {
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
                  {t('aux.requestCount', { count: kindRow.totals.requests.toLocaleString() })}
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
                        {modelLine(modelRow.model, modelRow.totals.requests, modelRow.cost, totalTokens(modelRow.totals))}
                      </span>
                    ))}
                  </div>
                )
                : null}
            </div>
          )
        })}
      </div>
      <div className={styles['asum']}>
        <span>{t('aux.totalCount', { count: aux.total.requests.toLocaleString() })}</span>
        <span>
          <span className={styles['onumsCost']}>{costText(aux.cost)}</span>
          {' · '}
          {formatTokens(totalTokens(aux.total))}
        </span>
      </div>
    </>
  )
  return compact ? <div className={styles['compact']}>{content}</div> : content
}
