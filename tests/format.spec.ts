import { describe, expect, it } from 'vitest'
import { formatCost, formatRate } from '../src/client/format.ts'

describe('formatCost', () => {
  it('formats with the ¥ symbol and two decimals', () => {
    expect(formatCost(1.25)).toBe('¥1.25')
    expect(formatCost(0)).toBe('¥0.00')
    expect(formatCost(123.456)).toBe('¥123.46')
    expect(formatCost(12345.6)).toBe('¥12345.60')
  })
})

describe('formatRate', () => {
  it('keeps integral rates bare', () => {
    expect(formatRate(2)).toBe('2')
    expect(formatRate(16)).toBe('16')
  })

  it('keeps a two-decimal minimum for fractional rates', () => {
    expect(formatRate(0.5)).toBe('0.50')
    expect(formatRate(1.5)).toBe('1.50')
  })

  it('keeps exact fractional rates up to four decimals', () => {
    expect(formatRate(0.25)).toBe('0.25')
    expect(formatRate(2.1)).toBe('2.10')
    expect(formatRate(0.025)).toBe('0.025')
  })
})
