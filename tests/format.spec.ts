import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { currencyViewOf, failuresTooltip, formatCost, formatRate, formatRateWithSymbol } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as TranslateNS<'token-usage'>

describe('formatCost', () => {
  it('formats with the ¥ symbol and two decimals', () => {
    expect(formatCost(1.25)).toBe('¥1.25')
    expect(formatCost(0)).toBe('¥0.00')
    expect(formatCost(123.456)).toBe('¥123.46')
    expect(formatCost(12345.6)).toBe('¥12345.60')
  })

  it('converts through a USD view, dividing by the exchange rate', () => {
    const usd = currencyViewOf({ currency: 'USD', usdExchangeRate: 7 })
    expect(formatCost(0, usd)).toBe('$0.00')
    // 1.4 RMB ÷ 7 = $0.20.
    expect(formatCost(1.4, usd)).toBe('$0.20')
    // 7 RMB ÷ 7 = $1.00.
    expect(formatCost(7, usd)).toBe('$1.00')
    // 123.45 RMB ÷ 7 = 17.6357… → $17.64.
    expect(formatCost(123.45, usd)).toBe('$17.64')
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

  it('converts through a USD view before formatting', () => {
    const usd = currencyViewOf({ currency: 'USD', usdExchangeRate: 7 })
    // 14 ÷ 7 = 2 stays integral and bare.
    expect(formatRate(14, usd)).toBe('2')
    // 8 ÷ 7 = 1.142857… → four decimals.
    expect(formatRate(8, usd)).toBe('1.1429')
    // 3.5 ÷ 7 = 0.5 → two-decimal minimum.
    expect(formatRate(3.5, usd)).toBe('0.50')
  })
})

describe('formatRateWithSymbol', () => {
  it('prefixes the view symbol onto the converted rate', () => {
    expect(formatRateWithSymbol(8)).toBe('¥8')
    expect(formatRateWithSymbol(0.5)).toBe('¥0.50')
    const usd = currencyViewOf({ currency: 'USD', usdExchangeRate: 7 })
    expect(formatRateWithSymbol(8, usd)).toBe('$1.1429')
    expect(formatRateWithSymbol(14, usd)).toBe('$2')
  })
})

describe('currencyViewOf', () => {
  it('returns the RMB pass-through view for CNY summaries', () => {
    expect(currencyViewOf({ currency: 'CNY', usdExchangeRate: 7 })).toEqual({ symbol: '¥', rate: 1 })
  })

  it('carries the wire exchange rate for USD summaries', () => {
    expect(currencyViewOf({ currency: 'USD', usdExchangeRate: 7.25 })).toEqual({ symbol: '$', rate: 7.25 })
  })
})

describe('failuresTooltip', () => {
  it('renders one label ×count line per class, largest first', () => {
    expect(failuresTooltip({ RATE_LIMIT: 16, TRANSPORT: 2 }, t)).toBe('限流 ×16\n网络异常 ×2')
    // Ties break on the code name ascending (RATE_LIMIT before TRANSPORT).
    expect(failuresTooltip({ TRANSPORT: 1, RATE_LIMIT: 1 }, t)).toBe('限流 ×1\n网络异常 ×1')
  })

  it('falls back to the raw code when the locale has no label', () => {
    expect(failuresTooltip({ BRAND_NEW_CODE: 3 }, t)).toBe('BRAND_NEW_CODE ×3')
  })

  it('yields an empty string for nothing to show', () => {
    expect(failuresTooltip(undefined, t)).toBe('')
    expect(failuresTooltip({}, t)).toBe('')
    expect(failuresTooltip({ RATE_LIMIT: 0 }, t)).toBe('')
  })
})
