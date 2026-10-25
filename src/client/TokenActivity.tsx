/**
 * Codex-style token activity calendar. Each square is one local day; columns
 * are Monday-first weeks and color intensity follows the active daily /
 * weekly / cumulative reading. A capped oldest-to-newest WAAPI stagger makes
 * the bricks arrive progressively without timers in React.
 *
 * @module token-usage/client/TokenActivity
 */

import { Fragment, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageDayRow } from '../wire.ts'
import type { ActivityCell, ActivityMode } from './activity-grid.ts'
import { buildActivityGrid } from './activity-grid.ts'
import { formatTokens } from './format.ts'
import { motionAllowed } from './cost-inflate-motion.ts'
import styles from './TokenActivity.module.css'

/** Keep a year-long entrance below one second of deferred motion. */
const STAGGER_MS = 8
const MAX_DELAY_MS = 960

/** Tooltip / accessible name of one cell in the active reading. */
function cellLabel(t: TranslateNS<'token-usage'>, cell: ActivityCell, mode: ActivityMode): string {
  const tokens = formatTokens(cell.value)
  if (mode === 'weekly') {
    return t('activity.weekLabel', { day: cell.day, from: cell.weekFrom, to: cell.weekTo, tokens })
  }
  return mode === 'cumulative'
    ? t('activity.cumulativeLabel', { day: cell.day, tokens })
    : t('activity.dayLabel', { day: cell.day, tokens })
}

/** One mount-animated brick. WAAPI avoids the embedded-host CSS keyframe /
 * custom-property failure mode already handled by cost-inflate-motion.ts. */
function ActivityBrick({ cell, mode, delay, t }: {
  cell: ActivityCell
  mode: ActivityMode
  delay: number
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)
  const label = cellLabel(t, cell, mode)
  useEffect(() => {
    const element = ref.current
    if (element === null || !motionAllowed() || typeof element.animate !== 'function') return
    const animation = element.animate([
      { opacity: 0, transform: 'translateY(3px) scale(0.72)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], {
      duration: 260,
      delay,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      // Hold the invisible first frame only during the stagger. Afterwards
      // ordinary CSS owns the resting and hover/focus transforms again.
      fill: 'backwards',
    })
    return () => { animation.cancel() }
    // Mount-only by design: a changed delay from a filter/data refresh must
    // not replay an existing day. Mode changes remount the calendar instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <span
      ref={ref}
      className={styles.brick}
      role="img"
      tabIndex={0}
      aria-label={label}
      title={label}
      data-level={cell.level}
    />
  )
}

/** Render the filtered activity calendar, or the same empty hint as the line. */
export function TokenActivity({ rows, from, to, mode = 'daily', t }: {
  rows: readonly UsageDayRow[]
  from?: string
  to?: string
  mode?: ActivityMode
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const weeks = buildActivityGrid(rows, mode, from, to)
  if (weeks.length === 0) return <p className={styles.empty}>{t('chart.empty')}</p>
  const ariaKey = mode === 'weekly'
    ? 'activity.ariaWeekly'
    : mode === 'cumulative' ? 'activity.ariaCumulative' : 'activity.ariaDaily'

  return (
    <div className={styles.scroll}>
      {/* Mode is the only deliberate full replay: data updates retain the
       * same calendar element and stable day keys, so live refreshes update
       * colors without restarting bricks that are already on screen. */}
      <div key={mode} className={styles.calendar} role="group" aria-label={t(ariaKey)}>
        {weeks.map((week, weekIndex) => (
          <Fragment key={week.key}>
            <span className={styles.month} aria-hidden="true">
              {week.month === undefined ? '' : t('activity.month', { month: String(week.month) })}
            </span>
            {week.cells.map((cell, weekday) => {
              if (cell === null) {
                return <span key={`${week.key}:${String(weekday)}`} className={styles.placeholder} aria-hidden="true" />
              }
              const delay = Math.min((weekIndex * 7 + weekday) * STAGGER_MS, MAX_DELAY_MS)
              return (
                <ActivityBrick key={`${mode}:${cell.day}`} cell={cell} mode={mode} delay={delay} t={t} />
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
