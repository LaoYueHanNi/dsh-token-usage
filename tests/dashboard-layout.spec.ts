import { readFileSync } from 'node:fs'
import { transform } from 'lightningcss'
import { describe, expect, it } from 'vitest'

describe('dashboard layout contracts', () => {
  it('bounds the request history, pins its header and reflows by pane width rather than OS theme or viewport', () => {
    const css = readFileSync(new URL('../src/client/UsageView.module.css', import.meta.url), 'utf8')
    expect(() => transform({ filename: 'UsageView.module.css', code: Buffer.from(css) })).not.toThrow()
    expect(css).toContain('container: usage / inline-size')
    expect(css).toContain('@container usage (max-width: 480px)')
    expect(css).toMatch(/\.poolTableWrap\s*\{[^}]*max-height: 196px;[^}]*overflow: auto;/)
    expect(css).toMatch(/\.poolTable th\s*\{[^}]*position: sticky;/)
    expect(css).not.toContain('prefers-color-scheme: dark')
  })
  it('keeps settings metrics four-across at every container breakpoint', () => {
    let compactGrid = ''
    let containerRules = 0
    transform({
      filename: 'OverviewBoard.module.css',
      code: readFileSync(new URL('../src/client/OverviewBoard.module.css', import.meta.url)),
      visitor: {
        Rule: {
          style(rule) {
            if (JSON.stringify(rule.value.selectors).includes('"name":"metricGridCompact"')) {
              compactGrid = JSON.stringify(rule.value.declarations)
            }
          },
          container(rule) {
            containerRules += 1
            // Page reflow must never silently turn the settings' two rows
            // into four rows again.
            expect(JSON.stringify(rule.value.rules)).not.toContain('"name":"metricGridCompact"')
          },
        },
      },
    })
    expect(compactGrid).toContain('"count":{"type":"number","value":4}')
    expect(containerRules).toBeGreaterThan(0)
  })
})
