import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKUPS_DIR, isBackupSnapshotName } from '../src/backup.ts'
import { PROVIDER_FIELD } from '../src/field-completion.ts'
import { dayFileName, dayFileNameOf, UsageLog } from '../src/usage-log.ts'
import { serializeRecord, type UsageRecord } from '../src/usage-record.ts'
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
    const dirEntries = (await readdir(dir)).sort()
    expect(dirEntries).toContain(BACKUPS_DIR)
    expect(dirEntries.filter(name => name.endsWith('.jsonl'))).toEqual([
      'usage-2026-01-10.jsonl',
      'usage-2026-01-15.jsonl',
    ])
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
      async list() { return [{ header: { id: 'session-1' as any } }] },
      async open(id: string) {
        if (id !== 'session-1') throw new Error('missing')
        return {
          read: () => Promise.resolve({
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
                  // The timed stream embedded in assistant/message carries
                  // the first token delta 420ms after the step start.
                  stream: [
                    { type: 'text-chunks', time0: targetDate - 3200 + 420, index: 0, dt: [], texts: ['hi'] },
                  ],
                },
              },
              { type: 'step/end', seq: 4, time: targetDate + 10, data: { turn: 1, step: 1 } },
            ],
          }),
          close: () => Promise.resolve(),
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

    const snapshots = (await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith('-backfill-timing')).toBe(true)
    const backupRow = JSON.parse((await readFile(join(dir, BACKUPS_DIR, snapshots[0]!, 'usage-2026-01-15.jsonl'), 'utf8')).trim())
    expect(backupRow.latencyMs).toBeUndefined()
  })

  it('does not create backups when timing backfill makes zero changes', async () => {
    const dir = await tempDir()
    const targetDate = new Date(2026, 0, 15, 8).getTime()
    const existing = {
      requestId: 'msg-done',
      time: targetDate,
      sessionId: 'session-1',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 3200,
      firstTokenLatencyMs: 420,
    }
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${serializeRecord(existing)}\n`)
    const fakePersistence = {
      async list() { return [] },
      async open() { throw new Error('unexpected') },
    }
    const log = new UsageLog(dir)
    expect(await log.backfillTiming(fakePersistence as any)).toBe(0)
    expect(existsSync(join(dir, BACKUPS_DIR))).toBe(false)
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
      async list() { return [{ header: { id: 'session-2' as any } }] },
      async open(id: string) {
        if (id !== 'session-2') throw new Error('missing')
        return {
          read: () => Promise.resolve({
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
          }),
          close: () => Promise.resolve(),
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

describe('UsageLog.reconcile', () => {
  it('unconditionally exempts attributed and unattributed aux rows and unknown future kinds', async () => {
    const dir = await tempDir()
    const dayTime = new Date(2026, 0, 15, 12).getTime()
    const ownedTitle: UsageRecord = {
      requestId: 'aux:session-title:1:1',
      time: dayTime,
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'aux',
      auxKind: 'session-title',
      usage: { inputTokens: 10, outputTokens: 2 },
    }
    const ownedReview: UsageRecord = {
      requestId: 'aux:auto-review:2:2',
      time: dayTime + 10,
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'aux',
      auxKind: 'auto-review',
      usage: { inputTokens: 20, outputTokens: 4 },
    }
    const unownedAux: UsageRecord = {
      requestId: 'aux:translation:3:3',
      time: dayTime + 20,
      sessionId: '',
      model: 'deepseek-chat',
      kind: 'aux',
      auxKind: 'translation',
      usage: { inputTokens: 8, outputTokens: 1 },
    }
    const staleFailure: UsageRecord = {
      requestId: 'failure:s1:99',
      time: dayTime + 30,
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'failure',
      failureCode: 'RATE_LIMIT',
    }
    const unknownFutureRaw = JSON.stringify({
      requestId: 'web-search:s1:4',
      time: dayTime + 40,
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'web-search',
      queries: ['foo'],
    })
    const originalBody = [
      serializeRecord(ownedTitle),
      serializeRecord(ownedReview),
      serializeRecord(unownedAux),
      serializeRecord(staleFailure),
      unknownFutureRaw,
      '{corrupt-line',
    ].join('\n') + '\n'
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), originalBody, 'utf8')

    const log = new UsageLog(dir)
    await log.scan()
    const eligible = log.ids()
    const removed = await log.reconcile(new Set<string>(), new Set(['s1']), eligible)
    expect(removed).toBe(1)

    const updatedLines = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')).trim().split('\n')
    expect(updatedLines).toHaveLength(5)
    expect(updatedLines.map(line => (line === '{corrupt-line' ? line : JSON.parse(line).requestId))).toEqual([
      'aux:session-title:1:1',
      'aux:auto-review:2:2',
      'aux:translation:3:3',
      'web-search:s1:4',
      '{corrupt-line',
    ])
    // Future unknown kind line keeps its original JSON verbatim without stripping extra fields.
    expect(updatedLines[3]).toBe(unknownFutureRaw)
    expect(log.has('failure:s1:99')).toBe(false)
    expect(log.has('aux:session-title:1:1')).toBe(true)

    const snapshots = (await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith('-reconcile')).toBe(true)
    expect(await readFile(join(dir, BACKUPS_DIR, snapshots[0]!, 'usage-2026-01-15.jsonl'), 'utf8')).toBe(originalBody)
  })

  it('reassigns misattributed session-log rows in place while preserving live fields', async () => {
    const dir = await tempDir()
    const dayTime = new Date(2026, 0, 15, 12).getTime()
    const misattributed: UsageRecord = {
      requestId: 'msg-parent-1',
      time: dayTime,
      sessionId: 'fork-child',
      model: 'deepseek-chat',
      usage: { inputTokens: 100, outputTokens: 20 },
      attemptTiming: { startedAt: dayTime - 500, settledAt: dayTime, firstTokenAt: dayTime - 400 },
    }
    const unreadableChildOwned: UsageRecord = {
      requestId: 'msg-unreadable',
      time: dayTime + 10,
      sessionId: 'unreadable-fork',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 2 },
    }
    await writeFile(
      join(dir, 'usage-2026-01-15.jsonl'),
      `${serializeRecord(misattributed)}\n${serializeRecord(unreadableChildOwned)}\n`,
      'utf8',
    )

    const log = new UsageLog(dir)
    await log.scan()
    let reassigned = 0
    const removed = await log.reconcile(
      new Set(['msg-parent-1', 'msg-unreadable']),
      new Set(['parent-1', 'fork-child']),
      log.ids(),
      new Map([
        ['msg-parent-1', 'parent-1'],
        ['msg-unreadable', 'parent-1'],
      ]),
      (count) => { reassigned = count },
    )
    expect(removed).toBe(0)
    expect(reassigned).toBe(1)

    const rows = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as UsageRecord)
    expect(rows[0]!.sessionId).toBe('parent-1')
    expect(rows[0]!.attemptTiming).toEqual({
      startedAt: dayTime - 500,
      settledAt: dayTime,
      firstTokenAt: dayTime - 400,
    })
    // Original owner session was not readable, so reassignment is safely skipped.
    expect(rows[1]!.sessionId).toBe('unreadable-fork')

    const snapshots = (await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith('-reconcile')).toBe(true)
  })

  it('creates no backup directory when reconcile makes zero changes', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${serializeRecord(record('m1', 1))}\n`, 'utf8')
    const log = new UsageLog(dir)
    await log.scan()
    const removed = await log.reconcile(new Set(['m1']), new Set(['session-1']), log.ids())
    expect(removed).toBe(0)
    expect(existsSync(join(dir, BACKUPS_DIR))).toBe(false)
  })
})

describe('UsageLog rewrite backups for refile and completeFields', () => {
  it('backs up source and existing target day files before refiling', async () => {
    const dir = await tempDir()
    const oldTime = new Date(2026, 0, 10, 8).getTime()
    const todayTime = new Date(2026, 0, 15, 12).getTime()
    const parked = record('old', 1, oldTime)
    const alreadyThere = record('existing-old', 2, oldTime + 1_000)
    const staying = record('today', 3, todayTime)
    const srcRaw = `${serializeRecord(parked)}\n${serializeRecord(staying)}\n`
    const dstRaw = `${serializeRecord(alreadyThere)}\n`
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), srcRaw, 'utf8')
    await writeFile(join(dir, 'usage-2026-01-10.jsonl'), dstRaw, 'utf8')

    const log = new UsageLog(dir)
    await log.scan()
    expect(await log.refileByEventDay()).toBe(1)

    const snapshots = (await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith('-refile')).toBe(true)
    const snapDir = join(dir, BACKUPS_DIR, snapshots[0]!)
    expect(await readFile(join(snapDir, 'usage-2026-01-15.jsonl'), 'utf8')).toBe(srcRaw)
    expect(await readFile(join(snapDir, 'usage-2026-01-10.jsonl'), 'utf8')).toBe(dstRaw)

    // Second pass has 0 moves and creates no extra backup.
    expect(await log.refileByEventDay()).toBe(0)
    expect((await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)).toHaveLength(1)
  })

  it('backs up modified day files before completeFields rewrite and skips backup on zero changes', async () => {
    const dir = await tempDir()
    const targetDate = new Date(2026, 0, 15, 8).getTime()
    const unattributed = {
      requestId: 'msg-no-provider',
      time: targetDate,
      sessionId: 'session-1',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    }
    const raw = `${serializeRecord(unattributed)}\n`
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), raw, 'utf8')

    const fakePersistence = {
      async list() { return [{ header: { id: 'session-1' as any } }] },
      async open() {
        return {
          read: () => Promise.resolve({
            events: [
              messageEvent({ messageId: 'msg-no-provider', seq: 1, time: targetDate, provider: 'deepseek-official' }),
            ],
          }),
          close: () => Promise.resolve(),
        }
      },
    }

    const log = new UsageLog(dir)
    const result = await log.completeFields(fakePersistence as any, [PROVIDER_FIELD])
    expect(result.patched).toBe(1)

    const snapshots = (await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith('-complete-fields')).toBe(true)
    expect(await readFile(join(dir, BACKUPS_DIR, snapshots[0]!, 'usage-2026-01-15.jsonl'), 'utf8')).toBe(raw)

    // Subsequent pass needs no edits and writes no extra backup.
    const second = await log.completeFields(fakePersistence as any, [PROVIDER_FIELD])
    expect(second.patched).toBe(0)
    expect((await readdir(join(dir, BACKUPS_DIR))).filter(isBackupSnapshotName)).toHaveLength(1)
  })
})

