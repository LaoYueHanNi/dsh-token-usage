import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractReleaseNotes } from '../scripts/release-notes.mjs'

describe('extractReleaseNotes', () => {
  const sample = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.5.0-rc.1] - 2026-12-01',
    '',
    '### Added',
    '- Pre-release feature',
    '',
    '## [0.4.16] - 2026-11-28',
    '',
    '### Fixed',
    '- Fix A',
    '',
    '## [0.4.15] - 2026-11-27',
    '',
    '### Added',
    '- Old feature',
    '',
    '[0.5.0-rc.1]: https://github.com/org/repo/compare/0.4.16...0.5.0-rc.1',
    '[0.4.16]: https://github.com/org/repo/compare/0.4.15...0.4.16',
    '[0.4.15]: https://github.com/org/repo/compare/0.4.14...0.4.15',
  ].join('\n')

  it('extracts a middle section cleanly and appends its compare link', () => {
    const notes = extractReleaseNotes(sample, '0.4.16')
    expect(notes).toBe('### Fixed\n- Fix A\n\n**完整变更对比**: https://github.com/org/repo/compare/0.4.15...0.4.16')
  })

  it('accepts leading v prefix and pre-release versions', () => {
    const notes = extractReleaseNotes(sample, 'v0.5.0-rc.1')
    expect(notes).toContain('Pre-release feature')
    expect(notes).toContain('0.4.16...0.5.0-rc.1')
  })

  it('strips trailing reference link definitions from the last section', () => {
    const notes = extractReleaseNotes(sample, '0.4.15')
    expect(notes).toBe('### Added\n- Old feature\n\n**完整变更对比**: https://github.com/org/repo/compare/0.4.14...0.4.15')
  })

  it('returns null when version is missing or section is empty', () => {
    expect(extractReleaseNotes(sample, '9.9.9')).toBeNull()
    expect(extractReleaseNotes(sample, 'Unreleased')).toBeNull()
  })

  it('parses the repository CHANGELOG.md for shipped versions', () => {
    const real = readFileSync(resolve('CHANGELOG.md'), 'utf8')
    const v0419 = extractReleaseNotes(real, '0.4.19')
    const v0418 = extractReleaseNotes(real, '0.4.18')
    expect(v0419).toContain('实时请求池保留条数可配置')
    expect(v0419).toContain('https://github.com/LaoYueHanNi/dsh-token-usage/compare/v0.4.18...v0.4.19')
    expect(v0418).toContain('子会话表展示团队模式、外部子代理与悬停语义名')
    expect(v0418).toContain('https://github.com/LaoYueHanNi/dsh-token-usage/compare/v0.4.17...v0.4.18')
  })

  it('extracts pre-release and the oldest section from the repository CHANGELOG.md', () => {
    const real = readFileSync(resolve('CHANGELOG.md'), 'utf8')
    const rc = extractReleaseNotes(real, '0.4.4-rc.1')
    expect(rc).toContain('破坏性变更 — 硬切宿主 dsh 0.1.7 配置范式')
    expect(rc).toContain('compare/0.4.3...0.4.4-rc.1')
    const first = extractReleaseNotes(real, 'v0.1.0')
    expect(first).toContain('初始版本发布')
    expect(first).toContain('https://github.com/LaoYueHanNi/dsh-token-usage/releases/tag/0.1.0')
    expect(first).not.toContain('[Unreleased]:')
    expect(first).not.toContain('[0.2.0]:')
  })
})
