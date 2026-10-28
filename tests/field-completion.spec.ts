import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { FIELD_COMPLETERS, PROVIDER_FIELD } from '../src/field-completion.ts'
import type { SyncPersistence } from '../src/sync.ts'
import { UsageLog } from '../src/usage-log.ts'
import { parseRecord, serializeRecord, type UsageRecord } from '../src/usage-record.ts'
import { compactionEvent, messageEvent, retryEvent, turnEndEvent } from './helpers.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'token-usage-fields-'))
}

function row(overrides: Partial<UsageRecord> & Pick<UsageRecord, 'requestId' | 'sessionId'>): UsageRecord {
  return {
    time: new Date(2026, 0, 15, 8).getTime(),
    model: 'deepseek-chat',
    ...overrides,
  }
}

function persistenceOf(sessions: Record<string, SessionEvent[]>, unreadable: readonly string[] = []): SyncPersistence {
  return {
    async list() {
      return Object.keys(sessions).map(id => ({ header: { id } }))
    },
    async open(id: string) {
      if (unreadable.includes(id) || sessions[id] === undefined) throw new Error(`missing ${id}`)
      return {
        header: { id },
        read: () => Promise.resolve({ events: sessions[id] }),
        close: () => Promise.resolve(),
      }
    },
  } as SyncPersistence
}

describe('PROVIDER_FIELD', () => {
  it('proves message, compaction, retry, and turn/end routes without guessing', () => {
    const events = [
      messageEvent({ messageId: 'msg-1', provider: 'deepseek', seq: 1 }),
      compactionEvent({ seq: 4, provider: 'deepseek' }),
      retryEvent({ seq: 6, provider: 'zai' }),
      turnEndEvent({ seq: 8 }),
    ] as SessionEvent[]
    const proofs = PROVIDER_FIELD.prove('s1', events)
    expect(proofs.get('msg-1')).toBe('deepseek')
    expect(proofs.get('compaction:s1:4')).toBe('deepseek')
    expect(proofs.get('failure:s1:6')).toBe('zai')
    // A later turn/end follows the request route, not the retry attempt's route.
    expect(proofs.get('failure:s1:8')).toBe('deepseek')
    expect(PROVIDER_FIELD.prove('s2', [turnEndEvent({ seq: 1 })] as SessionEvent[]).size).toBe(0)
  })

  it('skips auxiliary rows and rows that already name a route', () => {
    expect(PROVIDER_FIELD.needs(row({ requestId: 'a', sessionId: 's', kind: 'aux', auxKind: 'other' }))).toBe(false)
    expect(PROVIDER_FIELD.needs(row({ requestId: 'a', sessionId: '', }))).toBe(false)
    expect(PROVIDER_FIELD.needs(row({ requestId: 'a', sessionId: 's', provider: 'deepseek' }))).toBe(false)
    expect(PROVIDER_FIELD.needs(row({ requestId: 'a', sessionId: 's' }))).toBe(true)
  })
})

describe('UsageLog.completeFields', () => {
  it('fills only blank session rows and stamps when every candidate session was readable', async () => {
    const dir = await tempDir()
    const when = new Date(2026, 0, 15, 8).getTime()
    const lines = [
      row({ requestId: 'msg-1', sessionId: 's1', time: when }),
      row({ requestId: 'msg-kept', sessionId: 's1', time: when, provider: 'keep' }),
      row({ requestId: 'msg-1', sessionId: 's1', time: when, kind: 'aux', auxKind: 'other' }),
      row({ requestId: 'compaction:s1:4', sessionId: 's1', time: when, kind: 'compaction' }),
      row({ requestId: 'failure:s1:6', sessionId: 's1', time: when, kind: 'failure' }),
      row({ requestId: 'failure:s2:1', sessionId: 's2', time: when, kind: 'failure' }),
      '{not json',
    ]
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${lines.map(line => typeof line === 'string' ? line : serializeRecord(line)).join('\n')}\n`)
    const log = new UsageLog(dir)
    const result = await log.completeFields(persistenceOf({
      s1: [
        messageEvent({ messageId: 'msg-1', provider: 'deepseek', seq: 1 }),
        compactionEvent({ seq: 4, provider: 'deepseek' }),
        retryEvent({ seq: 6, provider: 'zai' }),
      ] as SessionEvent[],
      s2: [turnEndEvent({ seq: 1 })] as SessionEvent[],
    }), FIELD_COMPLETERS)
    expect(result).toEqual({ patched: 3, completedIds: ['provider'], failedSessions: 0 })
    const parsed = (await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8'))
      .split('\n')
      .filter(line => line !== '')
      .map(line => parseRecord(line))
    expect(parsed[0]?.provider).toBe('deepseek')
    expect(parsed[1]?.provider).toBe('keep')
    expect(parsed[2]?.provider).toBeUndefined()
    expect(parsed[3]?.provider).toBe('deepseek')
    expect(parsed[4]?.provider).toBe('zai')
    expect(parsed[5]?.provider).toBeUndefined()
    expect(parsed[6]).toBeNull()
  })

  it('does not stamp a completer while a candidate session is unreadable', async () => {
    const dir = await tempDir()
    const when = new Date(2026, 0, 15, 8).getTime()
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${[
      serializeRecord(row({ requestId: 'msg-1', sessionId: 's1', time: when })),
      serializeRecord(row({ requestId: 'msg-2', sessionId: 'gone', time: when })),
    ].join('\n')}\n`)
    const log = new UsageLog(dir)
    const result = await log.completeFields(persistenceOf({
      s1: [messageEvent({ messageId: 'msg-1', provider: 'deepseek' })] as SessionEvent[],
    }, ['gone']), FIELD_COMPLETERS)
    expect(result.patched).toBe(1)
    expect(result.completedIds).toEqual([])
    expect(result.failedSessions).toBe(1)
    const text = await readFile(join(dir, 'usage-2026-01-15.jsonl'), 'utf8')
    expect(text).toContain('"requestId":"msg-1"')
    expect(text).toContain('"provider":"deepseek"')
  })
})
