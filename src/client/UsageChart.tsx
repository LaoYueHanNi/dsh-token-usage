/**
 * Settings-page chart composer: preserves the existing line chart as the
 * default and adds a Codex-style activity calendar. View and activity-mode
 * switches are pure client state over the same already-filtered summary —
 * neither changes the date/model filters nor triggers another request.
 *
 * @module token-usage/client/UsageChart
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageDayRow, UsageHourRow } from '../wire.ts'
import type { ActivityMode } from './activity-grid.ts'
import { TokenActivity } from './TokenActivity.tsx'
import { TrendChart } from './TrendChart.tsx'
import styles from './UsageChart.module.css'

type ChartView = 'line' | 'activity'

/** One segment button with the same aria-pressed contract as existing tabs. */
function Segment({ active, label, onClick }: {
  active: boolean
  label: string
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={active ? `${styles.button} ${styles.active}` : styles.button}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/** Render the switchable token line/activity chart over filtered day rows. */
export function UsageChart({ rows, hours, from, to, t }: {
  rows: readonly UsageDayRow[]
  hours?: readonly UsageHourRow[]
  from?: string
  to?: string
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const [view, setView] = useState<ChartView>('line')
  const [activityMode, setActivityMode] = useState<ActivityMode>('daily')

  return (
    <section className={styles.section}>
      <div className={styles.head}>
        <h3 className={styles.title}>{t('chart.title')}</h3>
        <div className={styles.controls}>
          {view === 'activity' ? (
            <div className={styles.segmented} role="group" aria-label={t('activity.mode.label')}>
              <Segment active={activityMode === 'daily'} label={t('activity.mode.daily')} onClick={() => setActivityMode('daily')} />
              <Segment active={activityMode === 'weekly'} label={t('activity.mode.weekly')} onClick={() => setActivityMode('weekly')} />
              <Segment active={activityMode === 'cumulative'} label={t('activity.mode.cumulative')} onClick={() => setActivityMode('cumulative')} />
            </div>
          ) : null}
          <div className={styles.segmented} role="group" aria-label={t('chart.view.label')}>
            <Segment active={view === 'line'} label={t('chart.view.line')} onClick={() => setView('line')} />
            <Segment active={view === 'activity'} label={t('chart.view.activity')} onClick={() => setView('activity')} />
          </div>
        </div>
      </div>
      {view === 'line'
        ? (
          <TrendChart
            rows={rows}
            t={t}
            {...hours !== undefined ? { hours } : {}}
            {...from !== undefined ? { from } : {}}
            {...to !== undefined ? { to } : {}}
          />
        )
        : (
          <TokenActivity
            rows={rows}
            mode={activityMode}
            t={t}
            {...from !== undefined ? { from } : {}}
            {...to !== undefined ? { to } : {}}
          />
        )}
    </section>
  )
}
