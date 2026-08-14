import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dayFileName, UsageLog } from '../src/usage-log.ts'
import { serializeRecord } from '../src/usage-record.ts'
import { messageEvent } from './helpers.ts'
import { recordFromEvent } from '../src/usage-record.ts'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'token-usage-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  // Best-effort cleanup; a locked file on Windows must not fail the suite.
  await Promise.all(tempDirs.splice(0).map(dir => rmIfExists(dir)))
})

async function rmIfExists(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // cleanup is best-effort
  }
}

function event(messageId: string, seq: number, time = 1_700_000_000_000) {
  return messageEvent({ messageId, seq, time })
}

function record(messageId: string, seq: number, time = 1_700_000_000_000) {
  return recordFromEvent(event(messageId, seq, time), 'session-1', 'live')
}

describe('dayFileName', () => {
  it('formats a local-time date', () => {
    expect(dayFileName(new Date(2026, 0, 15, 12, 30))).toBe('usage-2026-01-15.jsonl')
    expect(dayFileName(new Date(2026, 11, 31, 23, 59))).toBe('usage-2026-12-31.jsonl')
  })
})

describe('UsageLog.record', () => {
  it('appends one line per record', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir, () => new Date(2026, 0, 15, 12))
    expect(await log.record(record('a', 1))).toBe(true)
    expect(await log.record(record('b', 2))).toBe(true)
    const lines = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"requestId":"a"')
    expect(lines[1]).toContain('"requestId":"b"')
  })

  it('dedupes by request id', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    expect(await log.record(record('a', 1))).toBe(true)
    expect(await log.record(record('a', 2))).toBe(false)
    const lines = (await readFile(join(dir, dayFileName(new Date())), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('serializes concurrent appends in call order', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    const calls = [record('a', 1), record('b', 2), record('c', 3)]
    await Promise.all(calls.map(r => log.record(r)))
    const lines = (await readFile(join(dir, dayFileName(new Date())), 'utf8')).trim().split('\n')
    expect(lines.map(line => JSON.parse(line).requestId)).toEqual(['a', 'b', 'c'])
  })

  it('writes to per-day files', async () => {
    const dir = await tempDir()
    const times = [new Date(2026, 0, 15, 23, 59), new Date(2026, 0, 16, 0, 1)]
    const log = new UsageLog(dir, () => times.shift() ?? new Date(2026, 0, 16))
    await log.record(record('a', 1, 1_750_000_000_000))
    await log.record(record('b', 2, 1_750_100_000_000))
    const names = (await readdir(dir)).sort()
    expect(names).toEqual(['usage-2026-01-15.jsonl', 'usage-2026-01-16.jsonl'])
  })

  it('creates the data directory on first write', async () => {
    const base = await tempDir()
    const dir = join(base, 'nested', 'dir')
    const log = new UsageLog(dir)
    expect(await log.record(record('a', 1))).toBe(true)
    expect((await readdir(dir)).length).toBe(1)
  })

  it('releases the claim and reports failure when the append fails', async () => {
    const base = await tempDir()
    const filePath = join(base, 'not-a-dir')
    await writeFile(filePath, 'x')
    const log = new UsageLog(filePath)
    expect(await log.record(record('a', 1))).toBe(false)
    expect(log.has('a')).toBe(false)
  })
})

describe('UsageLog.scan', () => {
  it('rebuilds the dedupe set across day files', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir, () => new Date(2026, 0, 15, 12))
    await log.record(record('a', 1))
    await log.record(record('b', 2))
    // A second day file, written directly to simulate a previous process.
    await writeFile(join(dir, 'usage-2026-01-14.jsonl'), `${serializeRecord(record('c', 9, 1_740_000_000_000))}\n`)

    const fresh = new UsageLog(dir)
    await fresh.scan()
    expect(fresh.has('a')).toBe(true)
    expect(fresh.has('b')).toBe(true)
    expect(fresh.has('c')).toBe(true)
    expect(fresh.has('missing')).toBe(false)
  })

  it('skips malformed lines and unreadable files without failing', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${serializeRecord(record('a', 1))}\n{broken\n`)
    const fresh = new UsageLog(dir)
    await fresh.scan()
    expect(fresh.has('a')).toBe(true)
  })

  it('ignores non-day files', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'notes.txt'), serializeRecord(record('a', 1)))
    const fresh = new UsageLog(dir)
    await fresh.scan()
    expect(fresh.has('a')).toBe(false)
  })

  it('tolerates a missing data directory', async () => {
    const base = await tempDir()
    const fresh = new UsageLog(join(base, 'absent'))
    await fresh.scan()
    expect(fresh.has('a')).toBe(false)
  })
})
