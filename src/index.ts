/**
 * Token-usage local plugin: a live hook persisting one JSONL row per
 * successful model request. On the FIRST startup the plugin auto-syncs the
 * historical session logs once (requests recorded before the plugin was
 * installed). When a webServer exists, the plugin also serves the stats
 * route backing the web settings page (browser half in `src/client`).
 *
 * The user-editable Config fields (`path`, `pricingRegion`) are declared
 * `.volatile()` so the dsh 0.1.7 settings service projects them into the
 * `token-usage` settings form (the browser card edits them through
 * `configForms`; saves land in the profile patch and commit live through
 * the loader without a plugin reload). A region pick re-resolves the feed
 * URL and re-syncs the mirror; a data directory change switches writes to
 * the new location and migrates every row and companion file across
 * (verbatim file copy, then source cleanup), so no restart and no manual
 * data move is needed.
 *
 * @module token-usage
 */

import { homedir } from 'node:os'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: pulls the ctx.settings declaration merge (SettingsForms:
// configure/describe) and the `loader/volatile-update` event declaration
// into this program.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx.sessionPersistence declaration merge into the program.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: pulls the merged `compaction/*` event payloads into the program.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: pulls the merged `llm/retry` event payload into the program.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
// Type-only: pulls the ctx.webServer declaration merge into the program.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the ctx.llm declaration merge (the provider directory).
import type {} from '@deepseek-ai/dsh-llm'
import { UsageLog } from './usage-log.ts'
import { SessionMetaStore } from './session-meta.ts'
import { cleanSource, copyData, type MigrationProgress } from './migrate.ts'
import { resolvePricingUrl, syncCloudPricing, type PricingSourceInput } from './pricing.ts'
import { extractFirstTokenTimeFromStream, modelOfEvent, recordOfEvent, type RequestTiming } from './usage-record.ts'
import { markTimingSynced, readSyncState } from './sync-state.ts'
import { autoSyncIfNeeded, syncHistory, titleOfEvent } from './sync.ts'
import { clearRecordCache, warmRecordCache } from './record-cache.ts'
import { ROLLUP_FILE_NAME, ROLLUP_TMP_FILE_NAME } from './rollup.ts'
import { createDirectoryGuardRoute, createFullSyncRoute, createMigrationRoute, createPricingRoute, createStatsRoute, type FullSyncTrigger } from './stats-route.ts'
import { currencyOfRegion, type DirectoryGuardView, type FullSyncView, type QuotaPayload } from './wire.ts'
import { createQuotaRoute } from './quota/quota-route.ts'
import { QuotaService } from './quota/quota-service.ts'
import { ProviderTracker, resolveCurrentProvider } from './quota/provider-tracking.ts'
import {
  resolveQuotaCredentials, withCatalogBaseUrl,
  type CredentialRecordReader, type CredentialResolver, type ProviderDirectory, type SettingsReader,
} from './quota/credentials.ts'

/**
 * Read through the volatile wrapper the dsh 0.1.7 loader places over
 * `.volatile()` Config fields: volatile commits swap the snapshot in place
 * without a reload, so every read resolves at call time. A bare value (test
 * doubles, the pre-wrap apply argument) passes through unchanged.
 */
function readVolatile<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && 'get' in value && typeof (value as { get: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

export interface Config {
  /** Data directory; defaults to `$DSH_HOME/token-usage` (`~/.dsh/token-usage`). */
  path?: Volatile<string | undefined> | string
  /** Explicit cloud pricing feed URL mirrored on every startup; wins over
   * every region setting. Defaults to the model-price-table repository the
   * analyzer also pulls from. Composition-only — never projected into the
   * settings form. */
  pricingUrl?: string
  /** Domestic (China) mirror; defaults to the gitee model-price-table feed.
   * Composition-only. */
  pricingUrlDomestic?: string
  /** Overseas mirror; defaults to the github model-price-table feed.
   * Composition-only. */
  pricingUrlOverseas?: string
  /** Which mirror to pull when `pricingUrl` is unset: `domestic` (default,
   * gitee) or `overseas` (github). Set once per install — no IP sniffing. */
  pricingRegion?: Volatile<'domestic' | 'overseas' | undefined> | 'domestic' | 'overseas'
  /** The provider quota feature (the input-bar button): enabled by default,
   * with the poll cadence the host asks the browser to follow.
   * Composition-only. */
  quota?: QuotaConfig
  /** Whether compaction summarize requests (`compaction/summary` events)
   * are recorded and billed like plain requests (default `true`). `false`
   * skips them in both the live hook and the history sync. Composition-only. */
  recordCompaction?: boolean
}

/** Composition knobs of the quota feature (cordis.yml level). */
export interface QuotaConfig {
  /** Master switch; `false` stops serving the quota route (the button hides). */
  enabled?: boolean
  /** Poll cadence the payload stamps (seconds); clamped to 15–3600. */
  intervalSec?: number
}

/**
 * Loading-time schema of the composition config (the official Cordis shape:
 * a `Config` type plus a same-named standard schema, validated by the loader
 * before `apply` runs). The `.volatile()` fields (`path`, `pricingRegion`)
 * are what the 0.1.7 settings service projects into the settings form — a
 * namespace with no volatile field is skipped by `settings.describe()` and
 * its browser card never appears. Keys stay optional — absent keys stay
 * absent, because the plugin's own resolution (`validateConfig` +
 * section-based defaults) is where defaults and unknown-key rejection live.
 * Schemastery's object keeps unknown keys in non-strict mode, so
 * `validateConfig` remains the loud rejection point for misspelled keys.
 */
// (No `z<Config>` annotation: the `.volatile()` wrappers widen the schema's
// inferred type past the plain `Config` shape, exactly as the reference
// migration in dsh-git-worktree does it.)
export const Config = z.object({
  path: z.string().volatile(),
  pricingUrl: z.string(),
  pricingUrlDomestic: z.string(),
  pricingUrlOverseas: z.string(),
  pricingRegion: z.union([z.const('domestic'), z.const('overseas')]).volatile(),
  recordCompaction: z.boolean(),
  quota: z.object({
    enabled: z.boolean(),
    intervalSec: z.number().min(15).max(3600),
  }),
})

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const unknown = Object.keys(config).find(key =>
    key !== 'path' && key !== 'pricingUrl' && key !== 'pricingUrlDomestic'
    && key !== 'pricingUrlOverseas' && key !== 'pricingRegion'
    && key !== 'recordCompaction'
    && key !== 'quota')
  if (unknown !== undefined) {
    throw new Error(`TokenUsageConfig: unknown key "${unknown}"`)
  }
  const path = readVolatile(config.path)
  if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
    throw new Error('TokenUsageConfig: "path" must be a non-empty string')
  }
  if (config.pricingUrl !== undefined && (typeof config.pricingUrl !== 'string' || config.pricingUrl.length === 0)) {
    throw new Error('TokenUsageConfig: "pricingUrl" must be a non-empty string')
  }
  if (config.pricingUrlDomestic !== undefined
      && (typeof config.pricingUrlDomestic !== 'string' || config.pricingUrlDomestic.length === 0)) {
    throw new Error('TokenUsageConfig: "pricingUrlDomestic" must be a non-empty string')
  }
  if (config.pricingUrlOverseas !== undefined
      && (typeof config.pricingUrlOverseas !== 'string' || config.pricingUrlOverseas.length === 0)) {
    throw new Error('TokenUsageConfig: "pricingUrlOverseas" must be a non-empty string')
  }
  const pricingRegion = readVolatile(config.pricingRegion)
  if (pricingRegion !== undefined
      && pricingRegion !== 'domestic' && pricingRegion !== 'overseas') {
    throw new Error('TokenUsageConfig: "pricingRegion" must be "domestic" or "overseas"')
  }
  if (config.recordCompaction !== undefined && typeof config.recordCompaction !== 'boolean') {
    throw new Error('TokenUsageConfig: "recordCompaction" must be a boolean')
  }
  if (config.quota !== undefined) {
    if (typeof config.quota !== 'object' || config.quota === null) {
      throw new Error('TokenUsageConfig: "quota" must be an object')
    }
    const quotaUnknown = Object.keys(config.quota).find(key => key !== 'enabled' && key !== 'intervalSec')
    if (quotaUnknown !== undefined) {
      throw new Error(`TokenUsageConfig: unknown quota key "${quotaUnknown}"`)
    }
    const { enabled, intervalSec } = config.quota
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error('TokenUsageConfig: quota "enabled" must be a boolean')
    }
    if (intervalSec !== undefined
        && (!Number.isFinite(intervalSec) || intervalSec < 15 || intervalSec > 3600)) {
      throw new Error('TokenUsageConfig: quota "intervalSec" must be a number within 15–3600')
    }
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

/**
 * Coalescing window for pricing re-sync requests. Startup arrives as several
 * near-simultaneous requests (the entry-config fallback and the settings
 * attach's change callback, order not guaranteed); collapsing them into one
 * fetch means a restart logs a single "pricing sync" line at the effective
 * URL even when the user picked a region.
 */
const PRICING_SYNC_COALESCE_MS = 250

/**
 * Startup grace period: within it, a re-published section that resolves to the
 * URL the startup already synced is not fetched again. The file settings
 * provider can re-commit the same section during boot (a watcher reconcile),
 * and such a transient must never turn one startup sync into two.
 */
const PRICING_SYNC_STARTUP_GRACE_MS = 5_000

/** The settings namespace this plugin serves; its browser card spells the same string. */
export const TOKEN_USAGE_NS = 'token-usage'

/**
 * The settings-facing subset of the config: the data directory and the mirror
 * region pick. `pricingUrlDomestic` / `pricingUrlOverseas` stay
 * composition-entry keys — the plugin still honors them from cordis.yml for
 * self-maintained forks, but a user-facing card should not restate raw feed
 * URLs. A descriptive line about this section lives in the card's copy, not
 * in the document.
 */
export interface SectionConfig {
  /** Data directory; resolved through `resolveDataDir` when absent. */
  path?: string
  /** Mirror to pull when no explicit `pricingUrl` is set: `domestic` (default) or `overseas`. */
  pricingRegion?: 'domestic' | 'overseas'
}

/** The section-shaped view of a config: absent keys stay absent
 * (`exactOptionalPropertyTypes`); volatile fields resolve at call time. */
function sectionOf(config: Config): SectionConfig {
  const path = readVolatile(config.path)
  const pricingRegion = readVolatile(config.pricingRegion)
  return {
    ...(path === undefined ? {} : { path }),
    ...(pricingRegion === undefined ? {} : { pricingRegion }),
  }
}

/** Live facts a section write is vetted against. */
export interface SectionGuard {
  /** Directory currently in force; undefined before the first start. */
  runningDir: string | undefined
  /** Sessions mid-conversation (an open turn) at validation time. */
  interactingSessions: number
}

/**
 * Count the sessions still mid-conversation: a session whose event log ends
 * inside an open turn (its last turn event is a `turn/start` with no closing
 * `turn/end`). Existence alone must not count — an idle open tab stays in the
 * store while its conversation ended, and events only append while a turn is
 * open, which is exactly the window that makes a migration unsafe.
 * dsh 0.1.2 made `Session.events` private behind `snapshotEvents()`;
 * callers pass each session's snapshot so this stays a plain duck type.
 * @param eventLogs - each live session's event snapshot (order irrelevant).
 * @returns how many of them are mid-conversation right now.
 */
export function countInteractingSessions(eventLogs: readonly (readonly { type: string }[])[]): number {
  let interacting = 0
  for (const events of eventLogs) {
    // The turn a log ends in is the one that matters; scan back to its edge.
    for (let i = events.length - 1; i >= 0; i--) {
      const type = events[i]?.type
      if (type === 'turn/start') {
        interacting++
        break
      }
      if (type === 'turn/end') break
    }
  }
  return interacting
}

/**
 * The refusal facts of one would-be directory save: `blocked` says the
 * section validator would refuse that save right now (a directory change
 * while any session is mid-conversation), `interactingSessions` counts those
 * sessions for the card's notice. The write veto ({@link validateSectionChange})
 * and the browser card's pre-save check (the `dir-guard` route) both answer
 * through this function, so the two can never disagree.
 * @param proposed - the stored path the save would land (`undefined` when the
 * save clears the override back to the default location).
 * @param guard - the running directory and mid-conversation session count.
 * @returns the verdict the card renders.
 */
export function directoryGuard(proposed: string | undefined, guard: SectionGuard): DirectoryGuardView {
  if (guard.runningDir === undefined) return { blocked: false, interactingSessions: guard.interactingSessions }
  if (resolveDataDir(proposed) === guard.runningDir) return { blocked: false, interactingSessions: guard.interactingSessions }
  return { blocked: guard.interactingSessions > 0, interactingSessions: guard.interactingSessions }
}

export function apply(ctx: Context, config: Config = {}) {
  validateConfig(config)
  // The plugin's named logger: every diagnostic joins the framework's log
  // pipeline instead of raw console output (the Cordis logging service).
  const logger = ctx.logger('token-usage')
  // The live entry config: volatile commits swap the snapshot inside
  // ctx.fiber.config in place (no reload), so every read goes through the
  // fiber first and falls back to the apply argument only off-fiber.
  const currentConfig = (): Config => (ctx.fiber?.config as Config | undefined) ?? config
  // The section source, as a thunk: reads see the current resolution at
  // call time, so both the pricing region and the data directory follow a
  // stored edit the moment the loader commits it.
  const sectionSource: () => SectionConfig = () => sectionOf(currentConfig())
  // The directory, log, and metadata index currently in force. Registrations
  // below read them per event and per request, so a settings-driven move
  // swaps the running directory without re-registering anything.
  let current: { dir: string; log: UsageLog; meta: SessionMetaStore } | undefined
  // Serialized relocations: a move runs to settlement before the next begins,
  // so two quick edits cannot interleave two migrations of the same files.
  let relocating: Promise<void> = Promise.resolve()
  // Live migration progress, polled by the browser card while a move runs.
  let migration: MigrationProgress | undefined
  // Live full-sync state, polled by the browser card while a manual scan runs.
  // The default `idle` means "never triggered" (or "the last run settled and
  // the card cleared it"); a card opening this section does not auto-clear
  // a terminal `done` / `failed` — those linger so the user can read the
  // result, and the next `triggerFullSync` overwrites them.
  let fullSyncStatus: FullSyncView = { status: 'idle' }
  // At most one manual scan at a time: a second POST returns 409 and the card
  // shows the button as disabled until the running scan settles.
  let fullSyncRunning = false

  /**
   * The directory currently in force; before the first start it resolves
   * through the section source, matching the directory `start` is about to
   * open (and the one the startup pricing sync targets).
   */
  const currentDir = (): string => current?.dir ?? resolveDataDir(sectionSource().path)

  /**
   * Move the running data directory as a two-phase commit: refuse while any
   * session is live (their events append to the source mid-copy), copy every
   * owned file verbatim with size verification, flip the running directory,
   * and only then remove the source files that verifiably landed. A failure
   * at any point leaves the source intact — data exists in both places or
   * only in the source, never only in the target.
   * @param nextDir - the resolved directory to move to.
   */
  const relocateTo = async (nextDir: string): Promise<void> => {
    const previous = current
    if (previous === undefined || previous.dir === nextDir) return

    // A mid-conversation session's events append to the source while the copy
    // runs; a copied file would then be stale the moment it lands. Refuse the
    // move and keep the current directory — the user lets the conversation
    // finish and retries.
    const interacting = countInteractingSessions(ctx.sessions.list().map(session => session.snapshotEvents()))
    if (interacting > 0) {
      throw new Error(`cannot move the data directory while ${String(interacting)} session(s) are mid-conversation; let them finish and save again`)
    }

    // Quiesce the source: drain queued appends so the files on disk are final.
    await previous.log.flush()
    // The metadata index writes on its own queue; drain it too, so the
    // sessions.json that migrates is final.
    await previous.meta.flush()

    migration = { phase: 'copying', done: 0, total: 0 }
    const report = (progress: MigrationProgress): void => {
      migration = { ...progress }
      logger.info(`[token-usage] moving ${String(progress.done)}/${String(progress.total)} (${progress.phase})`)
    }
    // Phase 1: copy everything, verbatim. An existing same-named target file
    // wins (live data or a user placement); a failure aborts before the flip.
    await copyData(previous.dir, nextDir, report)

    // Phase 2: flip the running configuration. A fresh log knows the rows the
    // target already holds, so post-flip events dedupe against them; a fresh
    // metadata index points at the copied sessions.json (mtime-stamped).
    const log = new UsageLog(nextDir, logger)
    await log.scan()
    const moved = await log.refileByEventDay()
    current = { dir: nextDir, log, meta: new SessionMetaStore(nextDir, logger) }
    clearRecordCache(previous.dir)
    if (moved > 0) invalidateDerivedState(nextDir)
    void warmRecordCache(nextDir, undefined, logger)

    // Phase 3: remove the source files that verifiably landed, then the
    // emptied directory. Nothing unknown is touched.
    migration = { phase: 'cleaning', done: 0, total: 0 }
    const result = await cleanSource(previous.dir, nextDir, report, logger)
    migration = undefined
    logger.info(`[token-usage] data directory moved to ${nextDir} (${String(result.cleaned)} files relocated)`)
  }

  // The feed URL the latest dispatch targeted; the startup gate reads only
  // its presence (the first sync has gone out), not the URL itself.
  let lastSyncedUrl: string | undefined
  // Coalescing handle: startup requests — the entry-config fallback below and
  // the settings attach's onChange, whose arrival order is not guaranteed —
  // collapse into one sync at the latest effective URL, so a restart logs a
  // single "pricing sync" line even when the user has set a region.
  let pendingSync: ReturnType<typeof setTimeout> | undefined
  // Within this window a section re-published to an already-synced URL is a
  // boot transient, not an edit, and must not re-fetch.
  const startupUntil = Date.now() + PRICING_SYNC_STARTUP_GRACE_MS

  /**
   * The effective URL inputs: the composition URL overrides and explicit
   * `pricingUrl`, plus the settings-resolved region pick. The section's URL
   * fields are composition-only now the card exposes just the switch, so
   * they ride on `config`; only `pricingRegion` crosses the settings wire
   * into the URL resolution (`path` is a directory concern, not a URL one).
   * Conditional spreads keep absent keys absent under
   * `exactOptionalPropertyTypes`.
   */
  const effectiveInput = (): PricingSourceInput => ({
    ...(config.pricingUrlDomestic !== undefined ? { pricingUrlDomestic: config.pricingUrlDomestic } : {}),
    ...(config.pricingUrlOverseas !== undefined ? { pricingUrlOverseas: config.pricingUrlOverseas } : {}),
    ...(sectionSource().pricingRegion !== undefined ? { pricingRegion: sectionSource().pricingRegion } : {}),
    ...(config.pricingUrl !== undefined ? { pricingUrl: config.pricingUrl } : {}),
  })

  /**
   * Refresh the cloud pricing mirror at the currently resolved feed URL: the
   * feed is cheap to fetch (small JSON) and the mirror is written atomically,
   * so a failed or stale fetch keeps the previous mirror and the stats page
   * keeps working. The URL resolves through resolvePricingUrl: an explicit
   * `pricingUrl` (composition) wins, otherwise `pricingRegion` picks the
   * domestic or overseas mirror. The mirror lands in the directory currently
   * in force, so a completed relocation re-seeds the new location even
   * though the pricing files traveled with the migration.
   */
  const syncPricing = (): void => {
    // Resolve once and capture: the .then below runs when its fetch settles,
    // by which time a newer dispatch may have repointed `lastSyncedUrl`, so
    // the log line must read the URL this fetch actually used.
    const url = resolvePricingUrl(effectiveInput())
    lastSyncedUrl = url
    void syncCloudPricing(currentDir(), url)
      .then((result) => {
        logger.info(`[token-usage] pricing sync (${url}): version ${result.version} (${result.models} models, ${result.aliases} aliases, USD rate ${result.usdExchangeRate})`)
      })
      .catch((error: unknown) => {
        // Offline or a slow network must never break the plugin: the previous
        // mirror (if any) stays active until a later sync retries the fetch.
        logger.warn('[token-usage] pricing sync failed:', error instanceof Error ? error.message : String(error))
      })
  }

  /**
   * Request a refresh of the mirror at the currently effective URL. Two
   * constraints keep one restart to exactly one fetch:
   *
   * - **Startup gate**: once the first sync has been dispatched, every request
   *   until `PRICING_SYNC_STARTUP_GRACE_MS` passes is a boot transient (the
   *   settings attach's callback, the file provider's watcher reconcile, a
   *   transient value flap) and is dropped.
   * - **Coalescing**: bursts of requests collapse into one fetch at the latest
   *   effective URL, so post-startup edits re-sync at most once per burst.
   */
  const requestSync = (): void => {
    if (lastSyncedUrl !== undefined && Date.now() < startupUntil) return
    if (pendingSync !== undefined) return
    pendingSync = setTimeout(() => {
      pendingSync = undefined
      syncPricing()
    }, PRICING_SYNC_COALESCE_MS)
  }
  // Drop a queued sync when this plugin's fiber disposes before the window
  // closes (a reload within the first ~250ms), so no stray fetch outlives it.
  ctx.effect(() => () => {
    if (pendingSync !== undefined) clearTimeout(pendingSync)
  }, 'token-usage: pricing sync coalescer')

  /**
   * Kick off one full scan over every persisted session log and stream the
   * live counts into {@link fullSyncStatus}. The scan is the same shape as
   * the one-shot startup sync (list + per-session read + UsageLog dedupe) — there is
   * no watermark shortcut here, so the user gets a guarantee that every
   * persisted request row the log does not yet hold will land. The run is
   * fire-and-forget: a second trigger while one is in flight returns
   * `{ started: false, reason: 'already-running' }` and the route answers
   * 409 so the card can keep its button disabled.
   */
  const triggerFullSync = (): FullSyncTrigger => {
    if (fullSyncRunning) return { started: false, reason: 'already-running' }
    const target = current
    if (target === undefined) return { started: false, reason: 'already-running' }
    fullSyncRunning = true
    fullSyncStatus = { status: 'running', processed: 0, total: 0, added: 0, skipped: 0, removed: 0, failedSessions: 0 }
    void syncHistory({ persistence: ctx.sessionPersistence, log: target.log, meta: target.meta, recordCompaction,
        onSessionFailure: (id, error) => {
          logger.warn(`[token-usage] session ${id} unreadable, skipped:`, error instanceof Error ? error.message : String(error))
        } },
      (tick) => {
        // The route's status thunk reads `fullSyncStatus` by reference, so each
        // tick is visible to the next poll without any other wiring.
        fullSyncStatus = { status: 'running', ...tick }
      },
    )
      .then(async (result) => {
        // `syncHistory` always emits a final tick at `processed: total`, but
        // we re-stamp the done state from the resolved result so the
        // `added` / `skipped` totals match the function's return exactly
        // (the last tick carries the in-loop counters; this stamp aligns
        // them with the result in case of any trailing read).
        const last = fullSyncStatus.status === 'running' ? fullSyncStatus
          : { processed: 0, total: 0, added: 0, skipped: 0, removed: 0, failedSessions: 0 }
        fullSyncStatus = {
          status: 'done',
          processed: last.processed,
          total: last.total,
          added: result.added,
          skipped: result.skipped,
          removed: result.removed,
          failedSessions: result.failedSessions,
        }
        // A manual scan usually backfills compactions this version just
        // learned to record (or rows a crash dropped): drop the derived
        // stats state so the next read aggregates over the appended rows.
        const moved = await target.log.refileByEventDay()
        if (result.added > 0 || result.removed > 0 || moved > 0) invalidateDerivedState(target.dir)
        if (moved > 0) {
          logger.info(`[token-usage] refiled ${String(moved)} rows onto event-day files`)
        }
        logger.info(`[token-usage] full sync done: ${String(result.added)} added, ${String(result.skipped)} skipped, ${String(result.removed)} removed, ${String(result.failedSessions)} failed sessions`)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        fullSyncStatus = { status: 'failed', error: message }
        logger.error('[token-usage] full sync failed:', error)
      })
      .finally(() => {
        fullSyncRunning = false
      })
    return { started: true }
  }

  // ---- Provider quota feature (input-bar button, `/token-usage/quota`) ----
  // Live tracking of which provider route each session uses: fed by the
  // same session events the recorder reads, but registered at apply scope
  // so tracking works before (and regardless of) the data directory start.
  const quotaTracker = new ProviderTracker()
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // request/context fires at dispatch — the provider is known before the
    // first token; assistant/message re-confirms it from the provenance.
    if (event.type === 'request/context') {
      quotaTracker.observe(session.id, event.data.provider, event.data.model)
      return
    }
    if (event.type === 'assistant/message') {
      quotaTracker.observe(session.id, event.data.message.source.provider, event.data.message.source.model)
    }
  })

  // The three seams the credential chain runs over. Each starts as a no-op
  // and upgrades when its (optional) host service attaches; a missing seam
  // shortens the chain rather than breaking it.
  let quotaDirectory: ProviderDirectory | undefined
  let quotaReadSettings: SettingsReader = () => undefined
  let quotaResolveCredential: CredentialResolver | undefined
  let quotaReadRecord: CredentialRecordReader | undefined
  ctx.inject(['llm'], (llmCtx) => {
    // The provider directory maps a route key to its settings location —
    // the one authoritative source (the built-in fallback in
    // credentials.ts covers hosts without the llm service).
    llmCtx.effect(() => {
      quotaDirectory = (provider) => {
        const entry = llmCtx.llm.listConfigurableProviders().find(item => item.provider === provider)
        return entry === undefined ? undefined : {
          settingsNs: entry.settingsNs,
          settingsPath: entry.settingsPath,
          displayName: entry.displayName,
        }
      }
      return () => { quotaDirectory = undefined }
    }, 'token-usage: quota provider directory')
  })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      // 0.1.7 SettingsForms serves every live namespace value through
      // describe() (the per-namespace get is gone); the credentials chain
      // reads provider sections (e.g. an apiKeyEnv placement) through it.
      quotaReadSettings = (ns) => settingsCtx.settings.describe().find(entry => entry.ns === ns)?.value
      return () => { quotaReadSettings = () => undefined }
    }, 'token-usage: quota settings reader')
  })
  // The host's default model selection: what a brand-new, never-requesting
  // session would dispatch to. Optional seam — a deployment without the
  // service leaves the quota button hidden until the session's first
  // request names its provider.
  let defaultProviderSelection: (() => string | undefined) | undefined
  ctx.inject(['agentDefaultModel'], (agentCtx) => {
    agentCtx.effect(() => {
      const service = (agentCtx as unknown as {
        agentDefaultModel?: { currentSelection?: () => { provider?: unknown } }
      }).agentDefaultModel
      if (service !== undefined && typeof service.currentSelection === 'function') {
        defaultProviderSelection = () => {
          const provider = service.currentSelection?.().provider
          return typeof provider === 'string' && provider !== '' ? provider : undefined
        }
      }
      return () => { defaultProviderSelection = undefined }
    }, 'token-usage: default model selection seam')
  })
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsCtx.effect(() => {
      quotaResolveCredential = async ref =>
        (await credentialsCtx.credentials.resolve(credentialRef(ref)))?.value
      // The record store is newer than the installed typings; read it
      // feature-detected (absent on older hosts — the env layer covers).
      const recordReader = (credentialsCtx.credentials as unknown as {
        readRecord?: (key: string) => Promise<{ key?: string } | undefined>
      }).readRecord
      if (typeof recordReader === 'function') {
        quotaReadRecord = key => recordReader.call(credentialsCtx.credentials, key)
      }
      return () => {
        quotaResolveCredential = undefined
        quotaReadRecord = undefined
      }
    }, 'token-usage: quota credential seam')
  })

  const quotaEnabled = config.quota?.enabled !== false
  const quotaIntervalSec = Math.min(3600, Math.max(15, Math.round(config.quota?.intervalSec ?? 60)))
  // Whether compaction summarize requests join the billing chain. Resolved
  // once at apply: the composition config is immutable for the runtime.
  const recordCompaction = config.recordCompaction !== false

  /**
   * Drop the derived stats state after a sync appended rows or a refile
   * moved rows onto a different day file. Frozen day files are no longer
   * immutable — history sync and refile write through them — so a rollup
   * whose `upto` already covers that day would skip the new contents, and
   * the record cache may hold a stale parse. Both are derived state: the
   * next stats read rebuilds them, so dropping them is lossless.
   */
  const invalidateDerivedState = (dir: string): void => {
    clearRecordCache(dir)
    void unlink(join(dir, ROLLUP_FILE_NAME)).catch(() => undefined)
    void unlink(join(dir, ROLLUP_TMP_FILE_NAME)).catch(() => undefined)
  }
  const quotaService = new QuotaService({
    resolveProvider: sessionId => resolveCurrentProvider({
      tracker: quotaTracker,
      ...(sessionId !== undefined ? { sessionId } : {}),
      defaultProvider: () => defaultProviderSelection?.(),
    }),
    resolveCredentials: async provider => withCatalogBaseUrl(provider, await resolveQuotaCredentials({
      provider,
      ...(quotaDirectory !== undefined ? { directory: quotaDirectory } : {}),
      readSettings: quotaReadSettings,
      ...(quotaResolveCredential !== undefined ? { resolveCredential: quotaResolveCredential } : {}),
      ...(quotaReadRecord !== undefined ? { readRecord: quotaReadRecord } : {}),
    })),
    intervalSec: quotaIntervalSec,
  })

  /**
   * Open (or move) the running data directory at the section-resolved
   * location. Idempotent: the first call opens the directory and registers
   * the listeners and routes; a later call with a different resolved
   * directory enqueues a serialized relocation, and one with the same
   * directory is a no-op. A refusal (active sessions) or a migration
   * failure leaves the running directory unchanged.
   */
  const start = (): void => {
    const resolved = resolveDataDir(sectionSource().path)
    if (current !== undefined) {
      if (resolved !== current.dir) {
        relocating = relocating.then(() => relocateTo(resolved)).catch((error: unknown) => {
          migration = undefined
          logger.error('[token-usage] data directory move failed:', error)
        })
      }
      return
    }
    const dir = resolved
    const log = new UsageLog(dir, logger)
    const meta = new SessionMetaStore(dir, logger)
    current = { dir, log, meta }
    void warmRecordCache(dir, undefined, logger)

    // Last-known route model per session: failure rows need a model to
    // attribute while turn/end names none, so the recorder follows the same
    // events the sync walk does (request/context route changes, then
    // assistant/message confirmations). Bounded by the session count.
    const lastModel = new Map<string, string>()
    interface ActiveStepTiming {
      turn: number
      step: number
      startTime: number
    }
    const activeSteps = new Map<string, ActiveStepTiming>()
    // Header facts are immutable, so one upsert per session is enough even
    // though events keep arriving; the index store dedupes the write anyway.
    const headerSeen = new Set<string>()
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      // Session-table identity capture, alongside the usage rows: the
      // latest-wins title fold (a rename, an auto-generated title, and a
      // fallback all append the same `session/title` event — who is last
      // wins) and the session header's cwd / subagent lineage, read off the
      // callback's session the first time it is seen.
      const title = titleOfEvent(event)
      // Fire-and-forget with a logged catch: a failed write must degrade to
      // "stale identity" (the index rebuilds from logs), not crash the host.
      if (title !== undefined) void meta.upsert(session.id, { title }).catch(error => logger.warn('[token-usage] session title upsert failed:', error))
      if (!headerSeen.has(session.id)) {
        headerSeen.add(session.id)
        // Duck-typed: a session without a header (host versions, test
        // doubles) simply contributes no identity fields.
        const header = (session as { header?: Session['header'] }).header
        const patch = header === undefined ? {} : {
          ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
          ...(header.origin === 'subagent' ? { origin: header.origin } : {}),
          ...(typeof header.parentSession === 'string' && header.parentSession !== ''
            ? { parentSession: header.parentSession } : {}),
        }
        if (Object.keys(patch).length > 0) void meta.upsert(session.id, patch).catch(error => logger.warn('[token-usage] session header upsert failed:', error))
      }
      if (event.type === 'step/start') {
        activeSteps.set(session.id, {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
        })
      }
      let timing: RequestTiming | undefined
      if (event.type === 'assistant/message') {
        const currentStep = activeSteps.get(session.id)
        if (currentStep !== undefined
            && currentStep.turn === event.data.turn
            && currentStep.step === event.data.step) {
          const latencyMs = Math.max(0, event.time - currentStep.startTime)
          // dsh 0.1.7 embeds the timed model stream inside assistant/message
          // (the assistant/chunk event is gone); the first token delta's
          // timestamp is read from those compact records.
          const firstTokenTime = 'stream' in event.data && event.data.stream
            ? extractFirstTokenTimeFromStream(event.data.stream)
            : undefined
          const firstTokenLatencyMs = firstTokenTime !== undefined
            ? Math.max(0, firstTokenTime - currentStep.startTime)
            : undefined
          timing = {
            latencyMs,
            ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
          }
          activeSteps.delete(session.id)
        }
      } else if (event.type === 'step/end' || event.type === 'turn/end') {
        activeSteps.delete(session.id)
      }
      const revealed = modelOfEvent(event)
      if (revealed !== undefined) lastModel.set(session.id, revealed)
      const record = recordOfEvent(
        event, session.id, lastModel.get(session.id) ?? '', recordCompaction, timing,
      )
      if (record === null) return
      // Fire-and-forget: the log serializes appends and reports its own failures.
      void current?.log.record(record)
    })

    // Refile rows that an older build parked in the sync-day file, then the
    // one-shot backfill. Both share the log's append queue, so a live write
    // cannot interleave with the rewrite. History sync then lands each new
    // row on the event's own day.
    void log.refileByEventDay()
      .then((moved) => {
        if (moved > 0) {
          logger.info(`[token-usage] refiled ${String(moved)} rows onto event-day files`)
          invalidateDerivedState(dir)
        }
        return autoSyncIfNeeded({ persistence: ctx.sessionPersistence, log, meta, recordCompaction,
          onSessionFailure: (id, error) => {
            logger.warn(`[token-usage] session ${id} unreadable, skipped:`, error instanceof Error ? error.message : String(error))
          } }, dir)
      })
      .then(async (result) => {
        if (result !== null) {
          logger.info(`[token-usage] first-run sync: ${result.added} added, ${result.skipped} skipped, ${String(result.removed)} removed, ${String(result.failedSessions)} failed sessions`)
          // Appended rows (compactions backfilled by an upgrade, or requests
          // a previous run missed) and rows the reconcile pass dropped both
          // invalidate the derived stats state before the cache re-warms over
          // the new contents — including writes into frozen day files the
          // rollup may already have absorbed.
          if (result.added > 0 || result.removed > 0) invalidateDerivedState(dir)
        }
        const state = await readSyncState(dir, logger)
        if (state !== null && state.timingSyncedAt === undefined && ctx.sessionPersistence !== undefined) {
          const patched = await log.backfillTiming(ctx.sessionPersistence)
          if (patched > 0) {
            logger.info(`[token-usage] backfilled timing figures for ${String(patched)} historical records`)
            invalidateDerivedState(dir)
          }
          await markTimingSynced(dir)
        }
        return warmRecordCache(dir, undefined, logger)
      })
      .catch((error: unknown) => {
        logger.error('[token-usage] first-run sync failed:', error)
      })

    // The stats endpoint backing the web settings page. Optional by design:
    // profiles without a webserver (headless runs) keep the logging plugin
    // and simply never mount the route; the browser half of this package
    // shows the page only when the host half serves the route. Both routes
    // read the running state per request, so a relocation serves from the
    // new location and reports its own progress without re-registering.
    ctx.inject(['webServer'], (webCtx) => {
      // The display currency follows the region pick live: the thunk reads the
      // settings-resolved section at request time, so a saved region switch
      // re-prices the page's currency on the next fetch without a restart.
      webCtx.effect(() => webCtx.webServer.register(
        createStatsRoute(currentDir, { currency: () => currencyOfRegion(effectiveInput().pricingRegion), logger }),
      ), 'token-usage: stats route')
      webCtx.effect(() => webCtx.webServer.register(
        createMigrationRoute(() => migration),
      ), 'token-usage: migration route')
      // The card's pre-save check for a staged directory edit: the settings
      // wire never delivers a refused write's reason (the bound scope recovers
      // silently), so this route answers the same verdict the validator will
      // enforce — before the write, with the mid-conversation count to show.
      webCtx.effect(() => webCtx.webServer.register(
        createDirectoryGuardRoute((proposed): DirectoryGuardView => directoryGuard(proposed, {
          runningDir: current?.dir,
          interactingSessions: countInteractingSessions(ctx.sessions.list().map(session => session.snapshotEvents())),
        })),
      ), 'token-usage: directory guard route')
      // The card's manual "scan again" affordance: `POST` kicks off a run,
      // `GET` returns the live progress. The route is read-only over the
      // shared status; the actual scan runs as the closure above.
      webCtx.effect(() => webCtx.webServer.register(
        createFullSyncRoute(() => fullSyncStatus, triggerFullSync),
      ), 'token-usage: full sync route')
      // The settings page's pricing-overview dialog: the full cloud-mirror
      // model list in model-row shape, filter-free by design (the overview is
      // not a filtered usage view, so it never rides the stats response).
      webCtx.effect(() => webCtx.webServer.register(
        createPricingRoute(currentDir, { currency: () => currencyOfRegion(effectiveInput().pricingRegion), logger }),
      ), 'token-usage: pricing route')
      // The input-bar quota button's data channel: the current provider's
      // quota snapshot (rate-limit windows / balance), served by the quota
      // service. A disabled feature still answers — with the `disabled`
      // variant the button hides behind, rather than a 404.
      webCtx.effect(() => webCtx.webServer.register(
        createQuotaRoute((sessionId, providerHint) => quotaEnabled
          ? quotaService.snapshot(sessionId, providerHint)
          : Promise.resolve({ status: 'disabled', intervalSec: quotaIntervalSec } satisfies QuotaPayload)),
      ), 'token-usage: quota route')
    })

    logger.info(`[token-usage] plugin loaded (data dir: ${dir})`)
  }

  const startFromSource = (): void => { start(); requestSync() }

  // dsh 0.1.7 settings wiring. The volatile Config fields above are what the
  // settings service projects into the `token-usage` form; `auto: false`
  // declares that this plugin renders its own card (the browser half's
  // `plugins.bundle.config` entry) rather than a schema-generated page.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'token-usage: settings presentation policy')
  })

  // The loader resolves the composition entry's config (composition layer
  // under the profile patch) before apply runs, so the first start reads the
  // final values directly — no deferred settings-attach wait. Saves from the
  // browser card commit volatile fields in place without a reload;
  // `loader/volatile-update` (dispatched to this fiber only) re-runs the
  // section-driven start: a directory change relocates, a region switch
  // re-syncs the pricing mirror.
  startFromSource()
  ctx.on('loader/volatile-update', () => { start(); requestSync() })
}
