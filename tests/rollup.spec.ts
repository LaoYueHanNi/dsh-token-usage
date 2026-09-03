import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRollup, writeRollup } from '../src/rollup.ts'
import type { RollupFile } from '../src/rollup.ts'
import { summarizeRecords } from '../src/stats.ts'
import type { UsageRecord } from '../src/usage-record.ts'

function record(time: number, model: string, usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, kind?: 'compaction'): UsageRecord {
  const fields = usage ?? { input: 10, output: 5, cacheRead: 3 }
  return {
    requestId: kind === 'compaction' ? `compaction-${time}` : `req-${time}-${model}`,
    time,
    sessionId: 's1',
    model,
    ...(kind === 'compaction' ? { kind } : {}),
    usage: {
      inputTokens: fields.input ?? 0,
      outputTokens: fields.output ?? 0,
      ...fields.cacheRead === undefined ? {} : { cacheReadTokens: fields.cacheRead },
      ...fields.cacheWrite === undefined ? {} : { cacheWriteTokens: fields.cacheWrite },
    },
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

  it('round-trips compaction totals and recent rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const rollup = rollupWith('2026-01-15', [
      record(1_700_000_000_000, 'deepseek-chat'),
      {
        ...record(1_700_000_000_001, 'deepseek-chat', undefined, 'compaction'),
        requestId: 'compaction:s1:7',
      },
    ])
    await writeRollup(dir, rollup)
    await expect(readRollup(dir)).resolves.toEqual(rollup)
    expect(rollup.total.compactions).toBe(1)
    expect(rollup.recent[0]).toMatchObject({ kind: 'compaction', requestId: 'compaction:s1:7' })
  })

  it('reads a legacy rollup whose totals lack the compactions key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rollup-'))
    const rollup = rollupWith('2026-01-15', [record(1_700_000_000_000, 'deepseek-chat')])
    // Strip the optional key everywhere, the way a pre-compaction rollup reads.
    for (const totals of [
      rollup.total,
      ...rollup.byDay.map(row => row.totals),
      ...rollup.byHour.map(row => row.totals),
      ...rollup.byModel.map(row => row.totals),
      ...rollup.rateRows.map(row => row.totals),
    ]) {
      delete totals.compactions
    }
    await writeFile(join(dir, 'rollup.json'), JSON.stringify(rollup))
    const loaded = await readRollup(dir)
    expect(loaded).not.toBeNull()
    expect(loaded!.total.compactions).toBeUndefined()
    expect(loaded!.total.requests).toBe(1)
  })
})
