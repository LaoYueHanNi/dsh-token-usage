import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRollup, writeRollup } from '../src/rollup.ts'
import type { RollupFile } from '../src/rollup.ts'
import { summarizeRecords } from '../src/stats.ts'
import type { UsageRecord } from '../src/usage-record.ts'

function record(time: number, model: string): UsageRecord {
  return {
    requestId: `req-${time}-${model}`,
    time,
    sessionId: 's1',
    model,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
  }
}

function rollupWith(upto: string, records: readonly UsageRecord[]): RollupFile {
  return { upto, ...summarizeRecords(records) }
}

describe('readRollup / writeRollup', () => {
  it('round-trips a written rollup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const rollup = rollupWith('2026-01-15', [
      record(1_700_000_000_000, 'deepseek-chat'),
      record(1_700_000_000_001, 'deepseek-reasoner'),
    ])
    await writeRollup(dir, rollup)
    await expect(readRollup(dir)).resolves.toEqual(rollup)
  })

  it('reads null for a missing rollup', async () => {
    const dir = join(tmpdir(), `token-usage-absent-${Date.now()}`)
    await expect(readRollup(dir)).resolves.toBeNull()
  })

  it('reads null for malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    await writeFile(join(dir, 'rollup.json'), 'not json')
    await expect(readRollup(dir)).resolves.toBeNull()
  })

  it('reads null when a required aggregate is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    await writeFile(join(dir, 'rollup.json'), JSON.stringify({ upto: '2026-01-15' }))
    await expect(readRollup(dir)).resolves.toBeNull()
  })

  it('drops invalid recent entries instead of failing the whole rollup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const rollup = rollupWith('2026-01-15', [record(1_700_000_000_000, 'deepseek-chat')])
    await writeRollup(dir, rollup)
    const raw = JSON.parse(await readFile(join(dir, 'rollup.json'), 'utf8')) as { recent: unknown[] }
    raw.recent.unshift({ requestId: 42 })
    await writeFile(join(dir, 'rollup.json'), JSON.stringify(raw))
    const loaded = await readRollup(dir)
    expect(loaded).not.toBeNull()
    expect(loaded!.recent.map(row => row.requestId)).toEqual(['req-1700000000000-deepseek-chat'])
  })

  it('leaves no temp file behind after writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    await writeRollup(dir, rollupWith('2026-01-15', []))
    await expect(readdir(dir)).resolves.not.toContain('rollup.json.tmp')
  })

  it('reads null for a pre-rateRows rollup so it rebuilds from the day files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const legacy = rollupWith('2026-01-15', [record(1_700_000_000_000, 'deepseek-chat')])
    delete (legacy as Partial<typeof legacy>).rateRows
    await writeFile(join(dir, 'rollup.json'), JSON.stringify(legacy))
    await expect(readRollup(dir)).resolves.toBeNull()
  })

  it('reads null for a pre-byHour rollup so it rebuilds from the day files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const legacy = rollupWith('2026-01-15', [record(1_700_000_000_000, 'deepseek-chat')])
    delete (legacy as Partial<typeof legacy>).byHour
    await writeFile(join(dir, 'rollup.json'), JSON.stringify(legacy))
    await expect(readRollup(dir)).resolves.toBeNull()
  })

  it('round-trips the hourly rows alongside the daily aggregate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const rollup = rollupWith('2026-01-15', [
      record(new Date(2026, 0, 15, 9).getTime(), 'deepseek-chat'),
      record(new Date(2026, 0, 15, 9).getTime(), 'deepseek-reasoner'),
      record(new Date(2026, 0, 15, 14).getTime(), 'deepseek-chat'),
    ])
    await writeRollup(dir, rollup)
    const loaded = await readRollup(dir)
    expect(loaded?.byHour.map(row => [row.hour, row.model])).toEqual([
      ['2026-01-15T09', 'deepseek-chat'],
      ['2026-01-15T09', 'deepseek-reasoner'],
      ['2026-01-15T14', 'deepseek-chat'],
    ])
  })
})
