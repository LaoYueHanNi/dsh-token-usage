// @vitest-environment jsdom
/**
 * Client DOM and theme tests for TrendChart.
 * Verifies that the chart senses light/dark mode from the shell's
 * documentElement colorScheme and adjusts stopOpacity / CSS theme classes.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TrendChart } from '../src/client/TrendChart.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageDayRow } from '../src/wire.ts'

const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as TranslateNS<'token-usage'>

const SAMPLE_ROWS: UsageDayRow[] = [
  {
    day: '2026-03-01',
    totals: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    },
    models: [{
      model: 'deepseek-chat',
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      cost: 0.01,
      requests: 2,
    }],
  },
  {
    day: '2026-03-02',
    totals: {
      inputTokens: 300,
      outputTokens: 400,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    },
    models: [{
      model: 'deepseek-chat',
      inputTokens: 300,
      outputTokens: 400,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      cost: 0.02,
      requests: 4,
    }],
  },
]

describe('TrendChart Theme Adaptations', () => {
  afterEach(() => {
    cleanup()
    document.documentElement.style.removeProperty('color-scheme')
  })

  it('renders dark mode with a pure line and no area glow', () => {
    document.documentElement.style.colorScheme = 'dark'
    const { container } = render(<TrendChart rows={SAMPLE_ROWS} t={t} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('data-theme')).toBe('dark')

    // Dark mode has completely removed the area glow
    expect(container.querySelector('linearGradient')).toBeNull()
    expect(container.querySelectorAll('path').length).toBe(1) // only line path
  })

  it('adapts to light mode with ultra-airy 0.045 wash', async () => {
    document.documentElement.style.colorScheme = 'light'
    const { container } = render(<TrendChart rows={SAMPLE_ROWS} t={t} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('data-theme')).toBe('light')

    const stops = container.querySelectorAll('linearGradient stop')
    expect(stops.length).toBe(3)
    expect(stops[0]?.getAttribute('stop-opacity')).toBe('0.045')
    expect(stops[1]?.getAttribute('stop-opacity')).toBe('0.012')
    expect(stops[2]?.getAttribute('stop-opacity')).toBe('0.0')
    expect(container.querySelectorAll('path').length).toBe(2) // area + line
  })

  it('dynamically adapts when the shell switches from dark to light', async () => {
    document.documentElement.style.colorScheme = 'dark'
    const { container } = render(<TrendChart rows={SAMPLE_ROWS} t={t} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('data-theme')).toBe('dark')
    expect(container.querySelector('linearGradient')).toBeNull()

    // Shell triggers theme switch to light
    document.documentElement.style.colorScheme = 'light'
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(svg?.getAttribute('data-theme')).toBe('light')
    const stops = container.querySelectorAll('linearGradient stop')
    expect(stops[0]?.getAttribute('stop-opacity')).toBe('0.045')
    expect(container.querySelectorAll('path').length).toBe(2)
  })
})
