/**
 * Daily total-token trend chart (browser half): a dependency-free SVG line
 * chart over the per-day rows of the already-filtered summary. The x axis
 * spans every calendar day of the active range — days without records plot
 * as zero — and an empty range renders a placeholder instead of an axis.
 *
 * @module token-usage/client/TrendChart
 */

import type { ReactNode } from 'react'
import type { UsageDayRow } from '../wire.ts'
import { daySeries } from './day.ts'
import styles from './TrendChart.module.css'

/** SVG canvas metrics; the element scales to the section width via viewBox. */
const WIDTH = 800
const HEIGHT = 190
const PAD = 16
const AXIS_LABELS = 22

/** X-axis label positions: first, middle, and last day for long ranges. */
function labelIndices(length: number): number[] {
  if (length <= 3) return Array.from({ length }, (_, index) => index)
  const middle = Math.floor((length - 1) / 2)
  return [...new Set([0, middle, length - 1])]
}

/**
 * Render the daily token line chart.
 * @param props - the filtered per-day rows plus the active range bounds
 * (absent when unfiltered; the chart then spans first to last row).
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export function TrendChart({ rows, from, to }: {
  rows: readonly UsageDayRow[]
  from?: string
  to?: string
}): ReactNode {
  const points = daySeries(rows, from, to)
  if (points.length === 0) {
    return <p className={styles.empty}>区间内暂无数据</p>
  }
  const max = Math.max(...points.map(point => point.tokens), 1)
  const innerWidth = WIDTH - PAD * 2
  const innerHeight = HEIGHT - PAD * 2 - AXIS_LABELS
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0
  const x = (index: number): number => PAD + (points.length > 1 ? index * step : innerWidth / 2)
  const y = (tokens: number): number => PAD + innerHeight - (tokens / max) * innerHeight
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.tokens).toFixed(1)}`)
    .join(' ')
  const radius = points.length > 90 ? 1.5 : points.length > 30 ? 2 : 3
  return (
    <svg
      role="img"
      aria-label="每日总 token 曲线"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={styles.chart}
    >
      <line
        x1={PAD} y1={PAD + innerHeight} x2={WIDTH - PAD} y2={PAD + innerHeight}
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
