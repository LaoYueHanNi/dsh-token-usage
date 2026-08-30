/**
 * Range date picker (browser half): the filter bar's single date control —
 * one trigger showing the active day range plus a lightweight calendar
 * popover. The range is picked with two clicks: the first lands an anchor
 * (start or end, order does not matter), the second settles the range
 * (min/max sorted); month navigation keeps the anchor, so a range may span
 * months (navigate, click, navigate back, click). While an anchor is live,
 * hovering previews the pending range; Escape or an outside pointerdown
 * closes the popover and DISCARDS the unfinished anchor (the committed
 * filters never change on cancel). A clear affordance releases the range
 * back to unconstrained — the capability the two native date inputs it
 * replaces carried.
 *
 * The popover interaction copies QuotaButton's pattern verbatim (click
 * toggles, document pointerdown outside closes, Escape closes); the plate
 * styling mirrors its panel (menu background, inverted border, shadow,
 * z-index 100).
 *
 * @module token-usage/client/DateRangePicker
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { dayKeyOf, monthGrid, monthViewOf, shiftMonth } from './day.ts'
import type { MonthView } from './day.ts'
import styles from './DateRangePicker.module.css'

/** Monday-first weekday header keys (index 0 = Monday). */
const WEEKDAY_KEYS = [
  'calendar.weekday.0', 'calendar.weekday.1', 'calendar.weekday.2', 'calendar.weekday.3',
  'calendar.weekday.4', 'calendar.weekday.5', 'calendar.weekday.6',
] as const

/** Props: the committed range ('' = unconstrained) and the change lift. */
export interface DateRangePickerProps {
  from: string
  to: string
  onChange: (next: { from: string; to: string }) => void
  t: TranslateNS<'token-usage'>
}

/** The month view the popover opens on: the range end, else its start, else today. */
function initialView(from: string, to: string): MonthView {
  const focus = to !== '' ? to : from !== '' ? from : dayKeyOf(new Date())
  return monthViewOf(focus)
}

/**
 * Render the trigger + calendar popover.
 * @param props - the committed range, the change lift, and the locale seat.
 * @returns the inline wrapper holding the trigger and, while open, the panel.
 */
export function DateRangePicker({ from, to, onChange, t }: DateRangePickerProps): ReactNode {
  const rootRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MonthView>(() => initialView(from, to))
  // The first click's day key; null until it lands, cleared on close.
  const [anchor, setAnchor] = useState<string | null>(null)
  // The hovered day key while an anchor is live (range preview); else null.
  const [hovered, setHovered] = useState<string | null>(null)

  // Every close path funnels here: cancel discards the unfinished anchor
  // (only a second click or the clear button commits anything).
  const closePanel = (): void => {
    setOpen(false)
    setAnchor(null)
    setHovered(null)
  }

  // Opening resets the selection progress and lands on the focused month.
  const openPanel = (): void => {
    setView(initialView(from, to))
    setAnchor(null)
    setHovered(null)
    setOpen(true)
  }

  // Outside click / Escape close — QuotaButton's pattern, one document
  // listener pair while open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      closePanel()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePanel()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // The two-click state machine: first click anchors, second settles the
  // sorted range, commits it, and closes. Clicking an EARLIER day second
  // still yields from <= to (the order of the two clicks never matters).
  const pickDay = (day: string): void => {
    if (anchor === null) {
      setAnchor(day)
      return
    }
    const lo = anchor < day ? anchor : day
    const hi = anchor < day ? day : anchor
    closePanel()
    onChange({ from: lo, to: hi })
  }

  const clear = (): void => {
    closePanel()
    onChange({ from: '', to: '' })
  }

  // What the grid highlights: the pending anchor (previewing through the
  // hover when one is live) while selecting, else the committed range.
  const shown = anchor !== null
    ? {
      from: hovered !== null && hovered < anchor ? hovered : anchor,
      to: hovered !== null && hovered > anchor ? hovered : anchor,
    }
    : { from, to }
  const today = dayKeyOf(new Date())
  const summary = from !== '' && to !== ''
    ? `${from} ${t('filter.separator')} ${to}`
    : from !== ''
      ? from
      : to !== ''
        ? to
        : t('filter.allDates')

  return (
    <span ref={rootRef} className={styles['wrapper']}>
      <button
        type="button"
        className={styles['trigger']}
        aria-label={t('filter.dateRange')}
        aria-expanded={open}
        onClick={() => { (open ? closePanel : openPanel)() }}
      >
        {summary}
      </button>
      {open
        ? (
          <div className={styles['panel']} role="dialog" aria-label={t('filter.dateRange')}>
            <div className={styles['head']}>
              <button
                type="button"
                className={styles['nav']}
                aria-label={t('calendar.prevMonth')}
                onClick={() => { setView(shiftMonth(view, -1)) }}
              >
                ‹
              </button>
              <span className={styles['monthTitle']}>
                {t('calendar.monthTitle', { year: String(view.year), month: String(view.month + 1) })}
              </span>
              <button
                type="button"
                className={styles['nav']}
                aria-label={t('calendar.nextMonth')}
                onClick={() => { setView(shiftMonth(view, 1)) }}
              >
                ›
              </button>
            </div>
            <div className={styles['weekdays']}>
              {WEEKDAY_KEYS.map(key => <span key={key} className={styles['weekday']}>{t(key)}</span>)}
            </div>
            <div className={styles['grid']}>
              {monthGrid(view).map(cell => {
                if (!cell.inMonth) {
                  // Neighbouring-month days render as blank placeholders so
                  // the shown month's date texts stay unique.
                  return <span key={`blank-${cell.day}`} className={styles['blank']} aria-hidden="true" />
                }
                const classes = [styles['day']]
                if (cell.day === shown.from || cell.day === shown.to) classes.push(styles['daySelected'])
                else if (shown.from !== '' && cell.day > shown.from && cell.day < shown.to) classes.push(styles['dayInRange'])
                if (cell.day === today) classes.push(styles['dayToday'])
                return (
                  <button
                    key={cell.day}
                    type="button"
                    className={classes.join(' ')}
                    aria-label={cell.day}
                    aria-pressed={cell.day === shown.from || cell.day === shown.to}
                    aria-current={cell.day === today ? 'date' : undefined}
                    onMouseEnter={() => { setHovered(cell.day) }}
                    onMouseLeave={() => { setHovered(null) }}
                    onClick={() => { pickDay(cell.day) }}
                  >
                    {Number(cell.day.slice(8))}
                  </button>
                )
              })}
            </div>
            <div className={styles['foot']}>
              <button type="button" className={styles['clear']} onClick={clear}>
                {t('filter.clear')}
              </button>
            </div>
          </div>
        )
        : null}
    </span>
  )
}
