import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dayFileName, dayFileNameOf, UsageLog } from '../src/usage-log.ts'
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

function event(messageId: string, seq: number, time = new Date(2026, 0, 15, 12).getTime()) {
  return messageEvent({ messageId, seq, time })
}

function record(messageId: string, seq: number, time = new Date(2026, 0, 15, 12).getTime()) {
  return recordFromEvent(event(messageId, seq, time), 'session-1')
}

describe('dayFileName', () => {
  it('formats a local-time date', () => {
    expect(dayFileName(new Date(2026, 0, 15, 12, 30))).toBe('usage-2026-01-15.jsonl')
    expect(dayFileName(new Date(2026, 11, 31, 23, 59))).toBe('usage-2026-12-31.jsonl')
    expect(dayFileNameOf(new Date(2026, 0, 15, 12).getTime())).toBe('usage-2026-01-15.jsonl')
  })
})

describe('UsageLog.record', () => {
  it('appends one line per record', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    expect(await log.record(record('a', 1))).toBe(true)
    expect(await log.record(record('b', 2))).toBe(true)
    const lines = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"requestId":"a"')
    expect(lines[1]).toContain('"requestId":"b"')
  })

  it('recreates the data directory when it vanishes under a running log', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    expect(await log.record(record('a', 1))).toBe(true)
    // The location is removed underneath the process (a migration that stayed
    // behind, a user cleanup): the next append must self-heal, not fail
    // forever.
    await rm(dir, { recursive: true, force: true })
    expect(await log.record(record('b', 2))).toBe(true)
    const lines = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"requestId":"b"')
  })

  it('dedupes by request id', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    expect(await log.record(record('a', 1))).toBe(true)
    expect(await log.record(record('a', 2))).toBe(false)
    const lines = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('serializes concurrent appends in call order', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    const calls = [record('a', 1), record('b', 2), record('c', 3)]
    await Promise.all(calls.map(r => log.record(r)))
    const lines = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map(line => JSON.parse(line).requestId)).toEqual(['a', 'b', 'c'])
  })

  it('writes each row to the event-day file, not the wall-clock day', async () => {
    const dir = await tempDir()
    const log = new UsageLog(dir)
    await log.record(record('a', 1, new Date(2026, 0, 15, 23, 59).getTime()))
    await log.record(record('b', 2, new Date(2026, 0, 16, 0, 1).getTime()))
    const names = (await readdir(dir)).sort()
    expect(names).toEqual(['usage-2026-01-15.jsonl', 'usage-2026-01-16.jsonl'])
    expect((await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8'))).toContain('"requestId":"a"')
    expect((await readFile(join(dir, 'usage-2026-01-16.jsonl'), 'utf8'))).toContain('"requestId":"b"')
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
    const log = new UsageLog(dir)
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

describe('UsageLog.refileByEventDay', () => {
  it('moves rows parked in the wrong day file onto the event day', async () => {
    const dir = await tempDir()
    const parked = record('old', 1, new Date(2026, 0, 10, 8).getTime())
    await writeFile(
      join(dir, 'usage-2026-01-15.jsonl'),
      `${serializeRecord(parked)}\n${serializeRecord(record('today', 2))}\n`,
    )
    const log = new UsageLog(dir)
    await log.scan()
    expect(await log.refileByEventDay()).toBe(1)
    expect((await readdir(dir)).sort()).toEqual(['usage-2026-01-10.jsonl', 'usage-2026-01-15.jsonl'])
    expect(await readFile(join(dir, 'usage-2026-01-10.jsonl'), 'utf8')).toContain('"requestId":"old"')
    expect(await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).toContain('"requestId":"today"')
    expect(await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).not.toContain('"requestId":"old"')
    // A second pass is a no-op (crash-safe / already-correct files).
    expect(await log.refileByEventDay()).toBe(0)
  })
})

describe('UsageLog.backfillTiming', () => {
  it('resolves and backfills missing timing figures from session persistence', async () => {
    const dir = await tempDir()
    const targetDate = new Date(2026, 0, 15, 8).getTime()
    const existing = {
      requestId: 'msg-1',
      time: targetDate,
      sessionId: 'session-1',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    }
    await writeFile(
      join(dir, 'usage-2026-01-15.jsonl'),
      `${serializeRecord(existing)}\n`,
    )

    const fakePersistence = {
      async list() { return [{ id: 'session-1' as any }] },
      async inspect(id: string) {
        if (id !== 'session-1') throw new Error('missing')
        return {
          events: [
            { type: 'step/start', seq: 1, time: targetDate - 3200, data: { turn: 1, step: 1 } },
            {
              type: 'assistant/message',
              seq: 3,
              time: targetDate,
              data: {
                turn: 1,
                step: 1,
                message: { id: 'msg-1', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
                // dsh 0.1.7 embeds the timed stream inside assistant/message;
                // the first token delta sits 420ms after the step start.
                stream: [
                  { type: 'text-chunks', time0: targetDate - 3200 + 420, index: 0, dt: [], texts: ['hi'] },
                ],
              },
            },
            { type: 'step/end', seq: 4, time: targetDate + 10, data: { turn: 1, step: 1 } },
          ],
        }
      },
    }

    const log = new UsageLog(dir)
    const patched = await log.backfillTiming(fakePersistence as any)
    expect(patched).toBe(1)

    const content = await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.latencyMs).toBe(3200)
    expect(parsed.firstTokenLatencyMs).toBe(420)

    // Second run should be a no-op since the row now has both latencyMs and firstTokenLatencyMs
    expect(await log.backfillTiming(fakePersistence as any)).toBe(0)
  })

  it('backfills firstTokenLatencyMs from compact stream for rows with existing latencyMs', async () => {
    const dir = await tempDir()
    const targetDate = new Date(2026, 0, 15, 8).getTime()
    const existing = {
      requestId: 'msg-2',
      time: targetDate,
      sessionId: 'session-2',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 3200,
    }
    await writeFile(
      join(dir, 'usage-2026-01-15.jsonl'),
      `${serializeRecord(existing)}\n`,
    )

    const fakePersistence = {
      async list() { return [{ id: 'session-2' as any }] },
      async inspect(id: string) {
        if (id !== 'session-2') throw new Error('missing')
        return {
          events: [
            { type: 'step/start', seq: 1, time: targetDate - 3200, data: { turn: 1, step: 1 } },
            {
              type: 'assistant/message',
              seq: 2,
              time: targetDate,
              data: {
                turn: 1,
                step: 1,
                message: { id: 'msg-2', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
                stream: [
                  {
                    type: 'text-chunks',
                    time0: targetDate - 3200 + 600,
                    index: 0,
                    dt: [],
                    texts: ['hi'],
                  },
                ],
              },
            },
            { type: 'step/end', seq: 3, time: targetDate + 10, data: { turn: 1, step: 1 } },
          ],
        }
      },
    }

    const log = new UsageLog(dir)
    const patched = await log.backfillTiming(fakePersistence as any)
    expect(patched).toBe(1)

    const content = await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.latencyMs).toBe(3200)
    expect(parsed.firstTokenLatencyMs).toBe(600)
  })
})

