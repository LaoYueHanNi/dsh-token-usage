/**
 * Quota display-format unit tests: the used/remaining derivation in both
 * report directions, the balance fraction, the severity thresholds, the
 * countdown shapes, and the money/percent figures.
 */
import { describe, expect, it } from 'vitest'
import {
  formatQuotaClock, formatQuotaMoney, formatQuotaPercent, formatResetCountdown,
  quotaRemainingPercent, quotaSeverityOf, quotaUsedPercent, finestQuotaWindow,
  quotaIconFillShare, quotaTriggerFigure,
} from '../src/client/quota-format.ts'

const NOW = 1_780_000_000_000

describe('quotaUsedPercent / quotaRemainingPercent', () => {
  it('prefers the explicit fields in each direction', () => {
    expect(quotaUsedPercent({ tier: 'five_hour', usedPercent: 62.5 })).toBe(62.5)
    expect(quotaUsedPercent({ tier: 'weekly', remainingPercent: 30 })).toBe(70)
    expect(quotaRemainingPercent({ tier: 'weekly', remainingPercent: 30 })).toBe(30)
    expect(quotaRemainingPercent({ tier: 'five_hour', usedPercent: 62.5 })).toBe(37.5)
  })

  it('derives the balance fraction when a total is known', () => {
    const window = { tier: 'balance' as const, remainingValue: 6.8, maxValue: 10, unit: 'usd' as const }
    expect(quotaUsedPercent(window)).toBeCloseTo(32)
    expect(quotaRemainingPercent(window)).toBeCloseTo(68)
  })

  it('returns undefined when no ratio is computable', () => {
    expect(quotaUsedPercent({ tier: 'balance', remainingValue: 5, unit: 'cny' })).toBeUndefined()
    expect(quotaRemainingPercent({ tier: 'balance', remainingValue: 5, unit: 'cny' })).toBeUndefined()
  })

  it('clamps out-of-range provider figures', () => {
    expect(quotaUsedPercent({ tier: 'five_hour', usedPercent: 120 })).toBe(100)
    expect(quotaRemainingPercent({ tier: 'five_hour', usedPercent: -5 })).toBe(100)
  })
})

describe('quotaSeverityOf', () => {
  it('bands on the remaining share, traffic-light: green >60, yellow 20–60, red <20', () => {
    expect(quotaSeverityOf({ tier: 'five_hour', usedPercent: 20 })).toBe('ok')
    expect(quotaSeverityOf({ tier: 'five_hour', usedPercent: 50 })).toBe('warn')
    expect(quotaSeverityOf({ tier: 'five_hour', usedPercent: 85 })).toBe('exhausted')
    // The band edges land in yellow (20 and 60 both read watch-it).
    expect(quotaSeverityOf({ tier: 'five_hour', usedPercent: 40 })).toBe('warn')
    expect(quotaSeverityOf({ tier: 'five_hour', remainingPercent: 20 })).toBe('warn')
    expect(quotaSeverityOf({ tier: 'five_hour', remainingPercent: 19 })).toBe('exhausted')
    expect(quotaSeverityOf({ tier: 'five_hour', remainingPercent: 61 })).toBe('ok')
  })

  it('a ratio-less balance reads by its amount: ok while funded, exhausted at ≤ 0', () => {
    expect(quotaSeverityOf({ tier: 'balance', remainingValue: 0.01, unit: 'usd' })).toBe('ok')
    expect(quotaSeverityOf({ tier: 'balance', remainingValue: 110.5, unit: 'cny' })).toBe('ok')
    expect(quotaSeverityOf({ tier: 'balance', remainingValue: 0, unit: 'cny' })).toBe('exhausted')
    expect(quotaSeverityOf({ tier: 'balance', remainingValue: -0.01, unit: 'cny' })).toBe('exhausted')
  })
})

describe('finestQuotaWindow', () => {
  it('picks the finest statistical unit: 5-hour over weekly over balance', () => {
    const fiveHour = { tier: 'five_hour' as const, usedPercent: 5 }
    const weekly = { tier: 'weekly' as const, usedPercent: 97 }
    const balance = { tier: 'balance' as const, remainingValue: 6.8, maxValue: 10, unit: 'usd' as const }
    // Order-independent: the 5-hour window wins however the payload lists.
    expect(finestQuotaWindow([weekly, fiveHour, balance])).toBe(fiveHour)
    expect(finestQuotaWindow([balance, weekly])).toBe(weekly)
    expect(finestQuotaWindow([balance])).toBe(balance)
    expect(finestQuotaWindow([])).toBeUndefined()
  })
})

describe('quotaIconFillShare', () => {
  it('maps a remaining percent onto 0–1, a funded amount onto a full ring, and empty onto the track', () => {
    expect(quotaIconFillShare({ tier: 'five_hour', usedPercent: 62.5 })).toBe(0.375)
    expect(quotaIconFillShare({ tier: 'balance', remainingValue: 6.8, maxValue: 10, unit: 'usd' })).toBeCloseTo(0.68)
    expect(quotaIconFillShare({ tier: 'balance', remainingValue: 110.5, unit: 'cny' })).toBe(1)
    expect(quotaIconFillShare({ tier: 'balance', remainingValue: 0, unit: 'cny' })).toBe(0)
    expect(quotaIconFillShare({ tier: 'balance', remainingValue: -0.01, unit: 'cny' })).toBe(0)
    expect(quotaIconFillShare(undefined)).toBe(0)
})

describe('quotaTriggerFigure', () => {
  it('reads the remaining share whenever a ratio exists', () => {
    expect(quotaTriggerFigure({ tier: 'five_hour', usedPercent: 62.5 })).toBe('37.5%')
    expect(quotaTriggerFigure({ tier: 'weekly', remainingPercent: 30 })).toBe('30%')
    expect(quotaTriggerFigure({ tier: 'balance', remainingValue: 6.8, maxValue: 10, unit: 'usd' })).toBe('68%')
  })

  it('falls back to the amount when no ratio is computable', () => {
    expect(quotaTriggerFigure({ tier: 'balance', remainingValue: 110.5, unit: 'cny' })).toBe('¥110.50')
    expect(quotaTriggerFigure({ tier: 'balance', remainingValue: 6.8, unit: 'usd' })).toBe('$6.80')
  })

  it('returns undefined for a missing or figure-less window', () => {
    expect(quotaTriggerFigure(undefined)).toBeUndefined()
    expect(quotaTriggerFigure({ tier: 'five_hour' })).toBeUndefined()
  })
})
})

describe('formatResetCountdown', () => {
  it('shapes minutes, hours, and days', () => {
    expect(formatResetCountdown(NOW + 48 * 60_000, NOW)).toBe('48m')
    expect(formatResetCountdown(NOW + (2 * 60 + 14) * 60_000, NOW)).toBe('2h 14m')
    expect(formatResetCountdown(NOW + (27 * 60 + 3) * 60_000, NOW)).toBe('1d 3h')
    expect(formatResetCountdown(NOW - 5_000, NOW)).toBe('0m')
  })
})

describe('figures', () => {
  it('formats percent with one decimal only when present', () => {
    expect(formatQuotaPercent(62)).toBe('62%')
    expect(formatQuotaPercent(62.5)).toBe('62.5%')
  })

  it('formats money with its symbol', () => {
    expect(formatQuotaMoney(6.8, 'usd')).toBe('$6.80')
    expect(formatQuotaMoney(110.5, 'cny')).toBe('¥110.50')
  })

  it('formats a wall-clock HH:MM stamp', () => {
    const date = new Date(NOW)
    const pad = (value: number): string => String(value).padStart(2, '0')
    expect(formatQuotaClock(NOW)).toBe(`${pad(date.getHours())}:${pad(date.getMinutes())}`)
  })
})
