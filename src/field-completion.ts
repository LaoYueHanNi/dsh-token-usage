/**
 * Field completion of the token-usage plugin: a registry of one-shot
 * "fill this absent field from the session log" passes. Live projection
 * and history sync already share {@link recordOfEvent}; a row written
 * before a field existed is never updated by that path (`requestId`
 * dedupe skips it). Each completer says which rows still lack its field
 * and how one session's events prove the value. The log walks every
 * pending completer in a single read of each session.
 *
 * Timing backfill stays outside this registry. It shipped first, with its
 * own marker, and moving it would rewrite day files without filling
 * anything new.
 *
 * @module token-usage/field-completion
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { providerOfEvent, type UsageRecord } from './usage-record.ts'

/**
 * One optional field that can be proved from a session log after the row
 * was written. `prove` walks the session once and returns request id →
 * proof. `fill` applies that proof only when the field is still absent.
 */
export interface FieldCompleter {
  /** Stable id stored in `state.json` `completedFields`. */
  readonly id: string
  /** Whether this row still lacks the field. Auxiliary rows and rows with
   * no session are never candidates: the session log cannot prove them. */
  needs(record: UsageRecord): boolean
  /** Proofs this session's events can offer, keyed by request id. */
  prove(sessionId: string, events: readonly SessionEvent[]): ReadonlyMap<string, unknown>
  /** Write the proof onto the row when the field is still absent.
   * @returns whether the row changed. */
  fill(record: UsageRecord, proof: unknown): boolean
}

/**
 * Route key of a usage row. The first completer on this registry.
 * Ordinary requests match `message.id` to `source.provider`. Compaction
 * and `llm/retry` match their own event's route. A `turn/end` error has
 * no route of its own; it takes the last `request/context` or
 * `assistant/message` route at or before that seq, and stays blank when
 * that walk proves nothing.
 */
export const PROVIDER_FIELD: FieldCompleter = {
  id: 'provider',
  needs(record) {
    if (record.kind === 'aux') return false
    if (record.sessionId === '') return false
    return record.provider === undefined || record.provider === ''
  },
  prove(sessionId, events) {
    const proofs = new Map<string, string>()
    let lastProvider = ''
    for (const event of events) {
      const revealed = providerOfEvent(event)
      if (revealed !== undefined) lastProvider = revealed
      if (event.type === 'assistant/message') {
        const provider = event.data.message.source.provider
        if (provider !== '') proofs.set(event.data.message.id, provider)
      } else if (event.type === 'compaction/summary') {
        if (event.data.provider !== '') proofs.set(`compaction:${sessionId}:${String(event.seq)}`, event.data.provider)
      } else if (event.type === 'llm/retry') {
        if (event.data.provider !== '') proofs.set(`failure:${sessionId}:${String(event.seq)}`, event.data.provider)
      } else if (event.type === 'turn/end' && event.data.reason.kind === 'error' && lastProvider !== '') {
        proofs.set(`failure:${sessionId}:${String(event.seq)}`, lastProvider)
      }
    }
    return proofs
  },
  fill(record, proof) {
    if (typeof proof !== 'string' || proof === '') return false
    if (record.provider !== undefined && record.provider !== '') return false
    record.provider = proof
    return true
  },
}

/** Completers the startup pass runs. Append a field here; do not add another backfill function. */
export const FIELD_COMPLETERS: readonly FieldCompleter[] = [PROVIDER_FIELD]
