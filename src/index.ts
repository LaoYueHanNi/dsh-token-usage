/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed). When a webServer exists, the plugin also serves the stats
 * route backing the web settings page (browser half in `src/client`).
 *
 * @module token-usage
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx.sessionPersistence declaration merge into the program.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: pulls the ctx.webServer declaration merge into the program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { UsageLog } from './usage-log.ts'
import { DEFAULT_PRICING_URL, syncCloudPricing } from './pricing.ts'
import { recordFromEvent } from './usage-record.ts'
import { autoSyncIfNeeded } from './sync.ts'
import { createStatsRoute } from './stats-route.ts'

export interface Config {
  /** Data directory; defaults to `$DSH_HOME/token-usage` (`~/.dsh/token-usage`). */
  path?: string
  /** Cloud pricing feed URL mirrored on every startup; defaults to the
   * model-price-table repository the analyzer also pulls from. */
  pricingUrl?: string
}

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const unknown = Object.keys(config).find(key => key !== 'path' && key !== 'pricingUrl')
  if (unknown !== undefined) {
    throw new Error(`TokenUsageConfig: unknown key "${unknown}"`)
  }
  if (config.path !== undefined && (typeof config.path !== 'string' || config.path.length === 0)) {
    throw new Error('TokenUsageConfig: "path" must be a non-empty string')
  }
  if (config.pricingUrl !== undefined && (typeof config.pricingUrl !== 'string' || config.pricingUrl.length === 0)) {
    throw new Error('TokenUsageConfig: "pricingUrl" must be a non-empty string')
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
export const inject = ['sessions', 'sessionPersistence']

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

  // Refresh the cloud pricing mirror on every startup: the feed is cheap to
  // fetch (small JSON) and the mirror is written atomically, so a failed or
  // stale fetch keeps the previous mirror and the stats page keeps working.
  void syncCloudPricing(dir, config.pricingUrl ?? DEFAULT_PRICING_URL)
    .then((result) => {
      console.log(`[token-usage] pricing sync: version ${result.version} (${result.models} models, ${result.aliases} aliases)`)
    })
    .catch((error: unknown) => {
      // Offline or a slow network must never break the startup: the previous
      // mirror (if any) stays active until a later startup retries the fetch.
      console.warn('[token-usage] pricing sync failed:', error instanceof Error ? error.message : String(error))
    })

  // The stats endpoint backing the web settings page. Optional by design:
  // profiles without a webserver (headless runs) keep the logging plugin and
  // simply never mount the route; the browser half of this package shows the
  // page only when the host half serves the route.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register(createStatsRoute(dir)), 'token-usage: stats route')
  })

  console.log(`[token-usage] plugin loaded (data dir: ${dir})`)
}
