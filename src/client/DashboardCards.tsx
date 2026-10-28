/**
 * The main page's dashboard (browser half): the four equal-height cards in
 * two rows — projects | sessions, models | runtime overhead — each a card
 * head (title + count, the session head carrying the sort) over the same
 * flat row lists the settings panel's tabs use. The runtime-overhead card
 * is the scroll/flash target of the composite metric card's overhead pill.
 *
 * @module token-usage/client/DashboardCards
 */

import type { RefObject } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuxSummary, CostState, CostedModelRow, CostedProviderRow, PricingTable, SessionUsageRow } from '../wire.ts'
import { OverheadRows } from './OverheadRows.tsx'
import { UsageRows, RowSortControl, PerfToggle } from './UsageRows.tsx'
import type { RowSort } from './UsageRows.tsx'
import type { ProjectUsageRow } from './project-rows.ts'
import type { CurrencyView } from './format.ts'
import styles from './DashboardCards.module.css'

/** The cards' fixed sort options: projects, models and providers pick
 * between token size and billed cost; sessions add last activity. The
 * models' performance view is a separate head toggle, not a sort pick. */
const SORT_PROJECT: readonly RowSort[] = ['tokens', 'cost']
const SORT_SESSION: readonly RowSort[] = ['tokens', 'cost', 'recent']
const SORT_MODEL: readonly RowSort[] = ['tokens', 'cost']
const SORT_PROVIDER: readonly RowSort[] = ['tokens', 'cost']

/** Props for the four-card dashboard. Every list arrives final from the
 * section; the seats (session jump, model filter, price dialog) pass
 * through to the rows. */
export interface DashboardCardsProps {
  /** The directory-tail folds (projects card). */
  projectRows: readonly ProjectUsageRow[]
  /** The priced per-model rows (models card). */
  modelRows: readonly CostedModelRow[]
  /** The served per-session rows (sessions card). */
  sessionRows: readonly SessionUsageRow[]
  /** The three lists' controlled sorts (tokens/cost; sessions add last
   * activity). */
  projectSort: RowSort
  onProjectSortChange: (next: RowSort) => void
  modelSort: RowSort
  onModelSortChange: (next: RowSort) => void
  /** The models card's performance view (a content switch next to the
   * sort control, not a sort pick); up, the card reads the speed rows
   * and the sort control yields its seat. */
  modelPerfView: boolean
  onModelPerfToggle: (next: boolean) => void
  /** The priced per-provider rows (providers card); `''` is the
   * unattributed remainder row. */
  providerRows: readonly CostedProviderRow[]
  /** Route key → display name for the provider rows. */
  providerNames: Readonly<Record<string, string>> | undefined
  providerSort: RowSort
  onProviderSortChange: (next: RowSort) => void
  sessionSort: RowSort
  onSessionSortChange: (next: RowSort) => void
  /** The auxiliary layer (overhead card; absent renders the empty hint). */
  aux: AuxSummary | undefined
  pricing: PricingTable
  costState: CostState
  view: CurrencyView
  t: TranslateNS<'token-usage'>
  /** Seats passed through to the row lists (absent on bare hosts). */
  sessionListed?: ((id: string) => boolean) | undefined
  onSessionOpen?: ((id: string) => void) | undefined
  onToggleModel?: ((model: string) => void) | undefined
  onModelName?: ((model: string) => void) | undefined
  /** The overhead card's ref: the metric card's pill scrolls here. */
  overheadCardRef: RefObject<HTMLDivElement>
  /** True while the overhead card flashes (pill just clicked). */
  overheadFlash: boolean
}

/**
 * Render the four-card dashboard: projects | sessions on the first row,
 * models | runtime overhead on the second. The lists cap their own height
 * and scroll inside the cards.
 */
export function DashboardCards({
  projectRows,
  modelRows,
  sessionRows,
  projectSort,
  onProjectSortChange,
  modelSort,
  onModelSortChange,
  modelPerfView,
  onModelPerfToggle,
  providerRows,
  providerNames,
  providerSort,
  onProviderSortChange,
  sessionSort,
  onSessionSortChange,
  aux,
  pricing,
  costState,
  view,
  t,
  sessionListed,
  onSessionOpen,
  onToggleModel,
  onModelName,
  overheadCardRef,
  overheadFlash,
}: DashboardCardsProps): ReactNode {
  return (
    <div className={styles['grid2']}>
      <div className={styles['panel']}>
        <div className={styles['panelHead']}>
          <span className={styles['panelTitle']}>
            {t('board.projects')}
            <span className={styles['panelCount']}>
              {projectSort === 'cost'
                ? t('board.byCost', { count: projectRows.length.toLocaleString() })
                : t('board.byTokens', { count: projectRows.length.toLocaleString() })}
            </span>
          </span>
          <RowSortControl
            value={projectSort}
            options={SORT_PROJECT}
            onChange={onProjectSortChange}
            ariaLabel={t('board.projects')}
            t={t}
          />
        </div>
        <UsageRows
          kind="project"
          projectRows={projectRows}
          sort={projectSort}
          pricing={pricing}
          costState={costState}
          view={view}
          t={t}
        />
      </div>
      <div className={styles['panel']}>
        <div className={styles['panelHead']}>
          <span className={styles['panelTitle']}>
            {t('board.sessions')}
            <span className={styles['panelCount']}>
              {t('board.sessionsCount', { count: sessionRows.length.toLocaleString() })}
            </span>
          </span>
          <RowSortControl
            value={sessionSort}
            options={SORT_SESSION}
            onChange={onSessionSortChange}
            ariaLabel={t('board.sessions')}
            t={t}
          />
        </div>
        <UsageRows
          kind="session"
          sessionRows={sessionRows}
          sort={sessionSort}
          costState={costState}
          view={view}
          t={t}
          sessionListed={sessionListed}
          onSessionOpen={onSessionOpen}
        />
      </div>
      <div className={styles['panel']}>
        <div className={styles['panelHead']}>
          <span className={styles['panelHeadLeft']}>
            <span className={styles['panelTitle']}>
              {t('board.models')}
              <span className={styles['panelCount']}>
                {modelPerfView
                  ? t('board.bySpeed', { count: modelRows.length.toLocaleString() })
                  : modelSort === 'cost'
                    ? t('board.byCost', { count: modelRows.length.toLocaleString() })
                    : t('board.byTokens', { count: modelRows.length.toLocaleString() })}
              </span>
            </span>
          </span>
          <span className={styles['panelHeadRight']}>
            <span className={modelPerfView ? styles['headHidden'] : undefined}>
              <RowSortControl
                value={modelSort}
                options={SORT_MODEL}
                onChange={onModelSortChange}
                ariaLabel={t('board.models')}
                t={t}
              />
            </span>
            <PerfToggle pressed={modelPerfView} onToggle={onModelPerfToggle} t={t} />
          </span>
        </div>
        <UsageRows
          kind="model"
          modelRows={modelRows}
          sort={modelSort}
          perfView={modelPerfView}
          pricing={pricing}
          costState={costState}
          view={view}
          t={t}
          onToggleModel={onToggleModel}
          onModelName={onModelName}
        />
      </div>
      <div className={styles['panel']}>
        <div className={styles['panelHead']}>
          <span className={styles['panelTitle']}>
            {t('board.providers')}
            <span className={styles['panelCount']}>
              {providerSort === 'cost'
                ? t('board.byCost', { count: providerRows.length.toLocaleString() })
                : t('board.byTokens', { count: providerRows.length.toLocaleString() })}
            </span>
          </span>
          <RowSortControl
            value={providerSort}
            options={SORT_PROVIDER}
            onChange={onProviderSortChange}
            ariaLabel={t('board.providers')}
            t={t}
          />
        </div>
        <UsageRows
          kind="provider"
          providerRows={providerRows}
          providerNames={providerNames}
          sort={providerSort}
          costState={costState}
          view={view}
          t={t}
        />
      </div>
      <div ref={overheadCardRef} className={overheadFlash ? `${styles['panel']} ${styles['flash']}` : styles['panel']}>
        <div className={styles['panelHead']}>
          <span className={styles['panelTitle']}>
            {t('aux.tab')}
            <span className={styles['panelCount']}>{t('aux.subtitle')}</span>
          </span>
        </div>
        <OverheadRows aux={aux} costState={costState} view={view} t={t} />
      </div>
    </div>
  )
}
