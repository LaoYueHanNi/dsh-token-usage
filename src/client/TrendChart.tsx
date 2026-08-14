/**
 * Daily total-token trend chart (browser half): a dependency-free SVG line
 * chart over the per-day rows of the already-filtered summary. The x axis
 * spans every calendar day of the active range — days without records plot
 * as zero — with day labels first/middle/last; the y axis grid uses round
 * 1/2/2.5/5 × 10ⁿ steps (K/M/B abbreviated). An empty range renders a
 * placeholder instead of an axis.
 *
 * @module token-usage/client/TrendChart
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageDayRow } from '../wire.ts'
import { daySeries } from './day.ts'
import { formatTokens } from './format.ts'
import styles from './TrendChart.module.css'

/** SVG canvas metrics; the element scales to the section width via viewBox. */
const WIDTH = 800
const HEIGHT = 190
const TOP = 12
const BOTTOM = 16
const LEFT = 44
const RIGHT = 16
const X_LABELS = 22

/** X-axis label positions: first, middle, and last day for long ranges. */
function labelIndices(length: number): number[] {
  if (length <= 3) return Array.from({ length }, (_, index) => index)
  const middle = Math.floor((length - 1) / 2)
  return [...new Set([0, middle, length - 1])]
}

/** The roundest step from 1/2/2.5/5 × 10ⁿ not below the rough target. */
export function niceStep(rough: number): number {
  const base = 10 ** Math.floor(Math.log10(rough))
  const fraction = rough / base
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return nice * base
}

/** The y-axis tick values from one step up to the chart top (inclusive). */
function tickValues(max: number): { top: number; ticks: number[] } {
  if (max === 0) return { top: 1, ticks: [] }
  const step = niceStep(max / 4)
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = step; value < top; value += step) ticks.push(value)
  ticks.push(top)
  return { top, ticks }
}

/**
 * Render the daily token line chart.
 * @param props - the filtered per-day rows plus the active range bounds
 * (absent when unfiltered; the chart then spans first to last row), and the
 * `t` seat for the empty hint and the chart aria-label.
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export function TrendChart({ rows, from, to, t }: {
  rows: readonly UsageDayRow[]
  from?: string
  to?: string
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const points = daySeries(rows, from, to)
  if (points.length === 0) {
    return <p className={styles.empty}>{t('chart.empty')}</p>
  }
  const max = Math.max(...points.map(point => point.tokens))
  const { top, ticks } = tickValues(max)
  const innerWidth = WIDTH - LEFT - RIGHT
  const innerHeight = HEIGHT - TOP - BOTTOM - X_LABELS
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0
  const x = (index: number): number => LEFT + (points.length > 1 ? index * step : innerWidth / 2)
  const y = (tokens: number): number => TOP + innerHeight - (tokens / top) * innerHeight
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.tokens).toFixed(1)}`)
    .join(' ')
  const radius = points.length > 90 ? 1.5 : points.length > 30 ? 2 : 3
  return (
    <svg
      role="img"
      aria-label={t('chart.aria')}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={styles.chart}
    >
      {ticks.map(tick => (
        <g key={tick}>
          <line x1={LEFT} y1={y(tick)} x2={WIDTH - RIGHT} y2={y(tick)} className={styles.grid} />
          <text x={LEFT - 6} y={y(tick) + 3} textAnchor="end" className={styles.tick}>
            {formatTokens(tick)}
          </text>
        </g>
      ))}
      <line
        x1={LEFT} y1={y(0)} x2={WIDTH - RIGHT} y2={y(0)}
        className={styles.axis}
      />
      <path d={path} className={styles.line} />
      {points.map((point, index) => (
        <circle key={point.day} cx={x(index)} cy={y(point.tokens)} r={radius} className={styles.dot} />
      ))}
      {labelIndices(points.length).map(index => (
        <text
          key={index}
          x={x(index)}
          y={HEIGHT - 6}
          textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          className={styles.tick}
        >
          {points[index]!.day.slice(5)}
        </text>
      ))}
    </svg>
  )
}
