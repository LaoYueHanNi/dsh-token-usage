/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed); every later sync is the user's decision, via the manual
 * `/token-usage-sync` command.
 *
 * @module token-usage
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx.sessionPersistence declaration merge into the program.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { UsageLog } from './usage-log.ts'
import { recordFromEvent } from './usage-record.ts'
import { autoSyncIfNeeded, syncHistory } from './sync.ts'

export interface Config {
  /** Data directory; defaults to `$DSH_HOME/token-usage` (`~/.dsh/token-usage`). */
  path?: string
}

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const unknown = Object.keys(config).find(key => key !== 'path')
  if (unknown !== undefined) {
    throw new Error(`TokenUsageConfig: unknown key "${unknown}"`)
  }
  if (config.path !== undefined && (typeof config.path !== 'string' || config.path.length === 0)) {
    throw new Error('TokenUsageConfig: "path" must be a non-empty string')
  }
}

/**
 * Resolve the data directory: an explicit `path` wins; otherwise
 * `$DSH_HOME/token-usage` (a blank `$DSH_HOME` counts as unset), else
 * `~/.dsh/token-usage`.
 */
export function resolveDataDir(configPath: string | undefined): string {
  if (configPath !== undefined) return configPath
  const envHome = process.env.DSH_HOME
  const base = typeof envHome === 'string' && envHome.trim() !== ''
    ? envHome
    : join(homedir(), '.dsh')
  return join(base, 'token-usage')
}

export const name = 'token-usage'
export const inject = ['sessions', 'sessionPersistence', 'commands']

export function apply(ctx: Context, config: Config = {}) {
  validateConfig(config)
  const dir = resolveDataDir(config.path)
  const log = new UsageLog(dir)

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'assistant/message') return
    const record = recordFromEvent(event, session.id)
    // Fire-and-forget: the log serializes appends and reports its own failures.
    void log.record(record)
  })

  // One-shot backfill for requests recorded before this plugin was installed.
  // Fire-and-forget: a failure leaves the marker unwritten and the next
  // startup retries; a crash mid-run is absorbed by the sync's dedupe.
  void autoSyncIfNeeded({ persistence: ctx.sessionPersistence, log }, dir)
    .then((result) => {
      if (result !== null) {
        console.log(`[token-usage] first-run sync: ${result.added} added, ${result.skipped} skipped`)
      }
    })
    .catch((error: unknown) => {
      console.error('[token-usage] first-run sync failed:', error)
    })

  ctx.commands.register({
    name: 'token-usage-sync',
    description: 'Manual re-sync of historical session token usage (deduped by request id)',
    handler: async (invocation): Promise<CommandResult> => {
      try {
        const { added, skipped } = await syncHistory(
          { persistence: ctx.sessionPersistence, log },
          invocation.signal,
        )
        return {
          kind: 'success',
          text: `Token usage sync: ${added} added, ${skipped} skipped (deduped)`,
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return { kind: 'error', text: 'Token usage sync cancelled' }
        }
        throw error
      }
    },
  })

  console.log(`[token-usage] plugin loaded (data dir: ${dir})`)
}
