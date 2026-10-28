/**
 * The stats HTTP route of the token-usage plugin: a webServer exact route
 * serving the JSON summary at `/token-usage/stats` for the web settings page.
 * The /api prefix is owned by the browser-transport connection plugin and its
 * RPC method table is closed, so the plugin data channel is its own route.
 *
 * @module token-usage/stats-route
 */

import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { MigrationProgress } from './migrate.ts'
import { consoleLogger, type LoggerLike } from './log.ts'
import { readPricingContext, resolveRate } from './pricing.ts'
import type { PricingContext } from './pricing.ts'
import { attachCosts, buildSessionRows, buildSummary, filterRecordsBySessions, filterSummary, requestSeriesOf, SESSION_ROW_LIMIT, summarizeRecords, summaryForSessions } from './stats.ts'
import type { RateResolver, SessionMetaEntry } from './stats.ts'
import { buildSessionRequestDetails } from './session-request-details.ts'
import type { LiveSnapshot } from './request-observe.ts'
import { readCachedRecords } from './record-cache.ts'
import { SessionMetaStore } from './session-meta.ts'
import { projectRowsOf } from './project-rows.ts'
import { bucketSeries, pointsOfBuckets } from './trend-bucket.ts'
import { decodeChildGroups, decodeSessionScope, DIR_GUARD_PATH, FULL_SYNC_PATH, MIGRATION_PATH, PRICING_PATH, STATS_PATH, UNPRICED_KEY } from './wire.ts'
import type { ChildGroup, ChildUsageSummary, CostedSummary, DirectoryGuardView, DisplayCurrency, FullSyncView, PricingOverviewPayload, PricingTable, RequestPoint, SessionRequestDetails, SessionUsageRow, StatsFields, StatsPayload, TokenSummary } from './wire.ts'
import { effectiveModelOf, type UsageRecord } from './usage-record.ts'
import { AssociationError } from './pricing-associations.ts'
import { PRICING_SYNC_PATH, type PricingSyncResult } from './wire.ts'

/** The stats endpoint path, exported for tests and the client half. */
export { STATS_PATH } from './wire.ts'

/** The migration-progress endpoint path, exported for the client half. */
export { MIGRATION_PATH } from './wire.ts'

/** The directory-guard endpoint path, exported for the client half. */
export { DIR_GUARD_PATH } from './wire.ts'

/** The full-sync endpoint path, exported for the client half. */
export { FULL_SYNC_PATH } from './wire.ts'

/** The pricing-overview endpoint path, exported for the client half. */
export { PRICING_PATH } from './wire.ts'

/** A day query key must be exactly `YYYY-MM-DD`. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u

/**
 * One filter dimension of the stats request: undefined when absent or blank,
 * the raw string otherwise. `sessionIds` collects every occurrence of the
 * `sessionId` query key — one fetch may scope to a session AND its subagent
 * subtree (the page aggregates parent + children in one request). The
 * session table's fold is NOT a query dimension: rows always fold over
 * subagent subtrees (see buildSessionRows), so no switch refetches.
 */
interface RawFilter {
  from: string | undefined
  to: string | undefined
  model: string | undefined
  sessionIds: readonly string[]
  childGroups: readonly ChildGroup[]
  fields: StatsFields
}

/** Read the filter query parameters off the request URL. */
function readFilters(req: IncomingMessage): RawFilter {
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams
  const pick = (key: string): string | undefined => {
    const value = params.get(key)
    return value === null || value === '' ? undefined : value
  }
  const fields = pick('fields')
  return {
    from: pick('from'),
    to: pick('to'),
    model: pick('model'),
    sessionIds: decodeSessionScope(params),
    childGroups: decodeChildGroups(params),
    fields: fields === 'chip' || fields === 'session' ? fields : 'full',
  }
}

/** Whether every present day key is well-formed and ordered. */
function isValidRange(filter: RawFilter): boolean {
  if (filter.from !== undefined && !DAY_KEY.test(filter.from)) return false
  if (filter.to !== undefined && !DAY_KEY.test(filter.to)) return false
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) return false
  return true
}

/**
 * Whether a request may read the stats: same-origin browser fetches only.
 * Browsers send `Sec-Fetch-Site` on cross-origin requests; a cross-site value
 * (or a cross-site GET from a page on another origin) is refused. The header
 * is absent for non-browser clients (curl, tests), which are allowed.
 * @param req - the incoming request.
 * @returns whether the request originates from the served page.
 */
export function isSameOriginFetch(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === undefined) return true
  return site === 'same-origin' || site === 'none'
}

/** How the route resolves the display currency per request; a thunk so a
 * live settings change (the region pick) lands without rebuilding the route. */
export interface StatsRouteOptions {
  currency?: () => DisplayCurrency
  /** Reads the data directory's provider-name registry (route key → latest
   * display name) for the payload's `providerNames`; omitted serves the
   * payload without it and the client falls back to the raw keys. */
  providerNames?: () => Promise<Readonly<Record<string, string>>>
  /** Diagnostic sink for data reads; defaults to console. */
  logger?: LoggerLike
  /** The live request observer backing the usage tab's request pool. A host
   * without an observer (headless, or attached before this seam existed)
   * omits it and `fields=session` reads degrade to settled-only details. */
  live?: () => {
    snapshot: (sessionIds: readonly string[]) => LiveSnapshot
    capability: SessionRequestDetails['liveCapability']
  }
}

/** Live progress of a data-directory relocation; undefined when none runs. */
export type MigrationStatus = MigrationProgress | undefined

/**
 * Build the migration-progress route the browser card polls while a move
 * runs. Read-only by construction: it answers the shared status object and
 * nothing else.
 * @param status - reads the live migration state.
 * @returns the exact GET route answering the progress JSON.
 */
export function createMigrationRoute(status: () => MigrationStatus): WebRoute {
  return {
    kind: 'exact',
    path: MIGRATION_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      if (!isSameOriginFetch(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(status() ?? null))
    },
  }
}

/**
 * Build the directory-guard route the browser card consults before saving a
 * staged directory edit: the settings wire never delivers a refused write's
 * reason, so the card asks here whether the save would be refused and shows
 * the verdict's count itself. Read-only by construction: it answers the
 * caller's judge verdict and writes nothing.
 * @param judge - answers the verdict for one proposed stored path
 * (`undefined` when the save would clear the override).
 * @returns the exact GET route answering the verdict JSON.
 */
export function createDirectoryGuardRoute(judge: (proposed: string | undefined) => DirectoryGuardView): WebRoute {
  return {
    kind: 'exact',
    path: DIR_GUARD_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      if (!isSameOriginFetch(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const raw = params.get('path')
      // A blank path is the clear-back-to-default gesture, not a stored ''.
      const proposed = raw === null || raw === '' ? undefined : raw
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(judge(proposed)))
    },
  }
}

/** How the pricing-overview route resolves the display currency per
 * request; a thunk so a live settings change (the region pick) lands without
 * rebuilding the route — same contract as {@link StatsRouteOptions}. */
export interface PricingRouteOptions {
  currency?: () => DisplayCurrency
  /** Diagnostic sink for data reads; defaults to console. */
  logger?: LoggerLike
}

/** Manual refresh uses the host's saved source, never a client-supplied URL. */
export function createPricingSyncRoute(sync: () => Promise<PricingSyncResult>): WebRoute {
  return {
    kind: 'exact',
    path: PRICING_SYNC_PATH,
    handler: async (req, res) => {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      if (req.method !== 'POST') {
        res.writeHead(405, { ...headers, allow: 'POST' })
        res.end(JSON.stringify({ error: 'method-not-allowed' }))
        return
      }
      if (!isSameOriginFetch(req)) {
        res.writeHead(403, headers)
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      try {
        const result = await sync()
        res.writeHead(200, headers)
        res.end(JSON.stringify(result))
      } catch (error: unknown) {
        res.writeHead(error instanceof AssociationError ? error.statusCode : 502, headers)
        res.end(JSON.stringify({ error: error instanceof AssociationError ? error.code : 'sync-failed' }))
      }
    },
  }
}

/**
 * Build the pricing-overview route the settings page's overview dialog reads:
 * the full cloud-mirror model list in its model-row shape (modelId + aliasPatterns
 * + family + rules, never flattened into the alias-keyed table). The overview
 * is deliberately filter-free — it serves every model the mirror carries, so
 * it takes no query parameters and stays independent of the stats filters.
 * @param dir - reads the directory currently in force (per request, so a
 * settings-driven move starts answering from the new location at once).
 * @param options - the currency thunk; defaults to CNY (the domestic default).
 * @returns the exact GET route serving the overview JSON.
 */
export function createPricingRoute(dir: () => string, options: PricingRouteOptions = {}): WebRoute {
  const logger = options.logger ?? consoleLogger
  return {
    kind: 'exact',
    path: PRICING_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      if (!isSameOriginFetch(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try {
        const dataDir = dir()
        const context = await readPricingContext(dataDir, logger)
        const { models, usdExchangeRate } = context
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          models,
          ...(context.feedVersion !== undefined ? { feedVersion: context.feedVersion } : {}),
          costState: context.available ? 'ready' : 'pricing-unavailable',
          ...(context.unavailableReason !== undefined ? { pricingUnavailableReason: context.unavailableReason } : {}),
          currency: options.currency?.() ?? 'CNY',
          usdExchangeRate,
        } satisfies PricingOverviewPayload))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }
}

/**
 * Outcome of one manual full-sync trigger.
 * - `started: true` — the run kicked off; the next poll will see the live counts.
 * - `started: false, reason: 'already-running'` — a run is still in flight;
 *   the card surfaces this as the button's disabled state and a 409 response.
 */
export type FullSyncTrigger =
  | { started: true }
  | { started: false; reason: 'already-running' }

/**
 * Build the full-sync route backing the card's manual "scan again" button.
 * The handler is small by design: it only owns the request/response shape
 * (GET polls the live status, POST kicks off a run). The actual scan lives
 * on the host half and updates the shared status object, which `status()`
 * reads. The scan is fire-and-forget on POST so the request never blocks
 * behind a long walk; the card polls until the status leaves `running`.
 * @param status - reads the shared status (the same view the card renders).
 * @param trigger - kicks off a new run when the host is idle.
 * @returns the exact route serving both methods.
 */
export function createFullSyncRoute(
  status: () => FullSyncView,
  trigger: () => FullSyncTrigger,
): WebRoute {
  return {
    kind: 'exact',
    path: FULL_SYNC_PATH,
    handler: (req, res) => {
      if (!isSameOriginFetch(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(status()))
        return
      }
      if (req.method === 'POST') {
        const result = trigger()
        if (!result.started) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: result.reason }))
          return
        }
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ status: 'running' }))
        return
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
    },
  }
}

/** Fold one child group into the slim row the usage tab's subagent table reads. */
function childBreakdown(
  records: readonly UsageRecord[],
  filter: RawFilter,
  dataDir: string,
  resolve: RateResolver,
  pricing: PricingTable,
  canonical: ReadonlyMap<string, string>,
  context: PricingContext,
  costState: CostedSummary['costState'],
  fallback: TokenSummary,
): Record<string, ChildUsageSummary> {
  const rows: Record<string, ChildUsageSummary> = {}
  for (const group of filter.childGroups) {
    const scoped = filterRecordsBySessions(records, group.sessionIds)
    const summary = attachCosts(
      { ...filterSummary({ dataDir, ...(costState === 'history-incomplete' ? summaryForSessions(fallback, group.sessionIds) : summarizeRecords(scoped, resolve)) }, filter.from, filter.to, filter.model, canonical), costState },
      pricing,
      canonical,
      context,
    )
    rows[group.id] = {
      total: summary.total,
      totalCost: summary.totalCost,
      unpricedModels: summary.unpricedModels,
      costState: summary.costState,
    }
  }
  return rows
}

/** Session-scoped wire shape: `full` keeps the CostedSummary (minus the
 * granular bySession cells — the fold happened server-side); `session` /
 * `chip` drop the unused pricing / rate / recent / hour layers, and
 * `session` sends a pre-bucketed request series (≤ 60 points) plus the
 * live request pool (`requestDetails`). */
function slimSessionPayload(input: {
  summary: CostedSummary
  sessionIds: readonly string[]
  series: readonly RequestPoint[]
  currency: DisplayCurrency
  usdExchangeRate: number
  fields: StatsFields
  children: Record<string, ChildUsageSummary> | undefined
  requestDetails: SessionRequestDetails | undefined
  providerNames: Readonly<Record<string, string>> | undefined
}): unknown {
  const { summary, sessionIds, series, currency, usdExchangeRate, fields, children, requestDetails, providerNames } = input
  // The granular per-session cells stay behind the route: session-scoped
  // consumers read totals / byModel / requestSeries, never the cells.
  const { bySession: _cells, ...summaryRest } = summary
  const requestSeries = fields === 'session' ? pointsOfBuckets(bucketSeries(series)) : [...series]
  const full = {
    ...summaryRest,
    scope: 'session' as const,
    sessionIds,
    requestSeries,
    currency,
    usdExchangeRate,
    ...(providerNames !== undefined ? { providerNames } : {}),
    ...children !== undefined ? { children } : {},
  }
  if (fields === 'full') return full
  const chip = {
    scope: 'session' as const,
    sessionIds,
    total: summary.total,
    totalCost: summary.totalCost,
    unpricedModels: summary.unpricedModels,
    costState: summary.costState,
    ...(summary.feedVersion !== undefined ? { feedVersion: summary.feedVersion } : {}),
    ...(summary.associationStorageError !== undefined ? { associationStorageError: summary.associationStorageError } : {}),
    ...(summary.pricingUnavailableReason !== undefined ? { pricingUnavailableReason: summary.pricingUnavailableReason } : {}),
    currency,
    usdExchangeRate,
    ...children !== undefined ? { children } : {},
  }
  if (fields === 'chip') return chip
  return {
    ...chip,
    byModel: summary.byModel,
    modelResolutions: summary.modelResolutions,
    byDay: summary.byDay,
    byProvider: summary.byProvider,
    ...(providerNames !== undefined ? { providerNames } : {}),
    requestSeries,
    // The request pool rides ONLY the `session` read: chip stays slim, and
    // the whole-log `full` read never grows runtime-state payloads.
    ...(requestDetails !== undefined ? { requestDetails } : {}),
  }
}

/**
 * Build the stats route over a data directory the caller may relocate live.
 * @param dir - reads the directory currently in force (per request, so a
 * settings-driven move starts answering from the new location at once).
 * @param options - the currency thunk; defaults to CNY (the domestic default).
 * @returns the exact GET route serving the JSON summary.
 */
export function createStatsRoute(dir: () => string, options: StatsRouteOptions = {}): WebRoute {
  // One metadata store per data directory (its mtime cache is per-path), so
  // repeated stats reads do not reparse an unchanged sessions.json. A
  // relocation keys a new entry and the old one just goes unused.
  const metaStores = new Map<string, SessionMetaStore>()
  const metaStoreOf = (dataDir: string): SessionMetaStore => {
    const existing = metaStores.get(dataDir)
    if (existing !== undefined) return existing
    const created = new SessionMetaStore(dataDir, options.logger ?? consoleLogger)
    metaStores.set(dataDir, created)
    return created
  }
  return {
    kind: 'exact',
    path: STATS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      if (!isSameOriginFetch(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const filter = readFilters(req)
      if (!isValidRange(filter)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('invalid filter')
        return
      }
      try {
        const dataDir = dir()
        const logger = options.logger ?? consoleLogger
        // The pricing table is user-maintained and may change between
        // requests; reading it per request keeps the page honest without
        // mixing snapshots; unchanged source content reuses its index.
        // Table and canonical map come from one feed parse so alias
        // folding cannot drift from the rates used to bill.
        const context = await readPricingContext(dataDir, logger)
        const { table: pricing, canonical, usdExchangeRate } = context
        // Per-record pricing: each record resolves through the rule chain at
        // its own timestamp (tier approximated by its input-side tokens).
        // The name resolved under is the record's effective model — the
        // provider-reported response model when present, the routed name
        // otherwise — the same key every aggregated dimension groups under.
        const resolve: RateResolver = record => {
          const rules = context.ratesForModel(effectiveModelOf(record))
          if (rules === undefined) return UNPRICED_KEY
          const tokens = record.usage
          const contextSize = tokens === undefined ? 0
            : tokens.inputTokens + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0)
          return resolveRate(rules, record.time, contextSize).key
        }
        // Session-scoped reads fold raw records for request-time granularity.
        // Cached session cells retain usage if repricing is incomplete.
        // Frozen day files come from the
        // process cache so chip polls and the usage tab do not re-parse
        // history; today's file re-reads when its stamp changes.
        const allRecords = filter.sessionIds.length > 0 || filter.childGroups.length > 0
          ? await readCachedRecords(dataDir, undefined, logger)
          : undefined
        const scoped = filter.sessionIds.length > 0 && allRecords !== undefined
          ? filterRecordsBySessions(allRecords, filter.sessionIds)
          : undefined
        const whole = await buildSummary(dataDir, undefined, resolve, logger, {
          fingerprint: context.fingerprint,
          isCurrent: async () => dir() === dataDir && (await readPricingContext(dataDir, logger)).fingerprint === context.fingerprint,
        })
        const base = scoped !== undefined ? { dataDir, ...(whole.costState === 'history-incomplete'
          ? summaryForSessions(whole, filter.sessionIds) : summarizeRecords(scoped, resolve)) } : whole
        const summary = attachCosts(
          { ...filterSummary(base, filter.from, filter.to, filter.model, canonical),
            ...(whole.costState !== undefined ? { costState: whole.costState } : {}) },
          pricing,
          canonical,
          context,
        )
        // Display-currency metadata: amounts stay RMB on the wire; the
        // page converts (÷ usdExchangeRate) when the region pick says USD.
        const currency = options.currency?.() ?? 'CNY'
        // The provider-name registry rides every payload that carries the
        // provider dimension; a host without the registry seam serves the
        // raw keys and the client falls back to them.
        const providerNames = options.providerNames !== undefined
          ? await options.providerNames().catch(() => undefined)
          : undefined
        // The session table's final rows: the costed bySession cells fold
        // per top-level session (the whole subtree merges in), sorted by
        // cost and truncated top-N server-side, with the metadata index's
        // titles and directories attached. The fold is unconditional —
        // subagents badge through childCount, never their own rows.
        const metaIndex = await metaStoreOf(dataDir).read()
        const meta = new Map<string, SessionMetaEntry>(Object.entries(metaIndex))
        // Project totals must see every root, not just the most expensive
        // sessions retained in the bounded session-list payload.
        const allSessionRows = buildSessionRows(summary, meta, Infinity)
        const sessionRows: readonly SessionUsageRow[] = allSessionRows.slice(0, SESSION_ROW_LIMIT)
        // Strip the granular cells from the whole-scope payload: the client
        // renders the folded rows, and sending the cells would duplicate
        // every aggregate once more on the wire.
        const { bySession: _cells, ...summaryRest } = summary
        const children = allRecords !== undefined && filter.childGroups.length > 0
          ? childBreakdown(allRecords, filter, dataDir, resolve, pricing, canonical, context, summary.costState, whole)
          : undefined
        // The live request pool (fields=session only): merge the scoped
        // persisted records with the observer's runtime state — scope filter
        // and dedupe happen before the 20-item cut inside the builder. A
        // host without the observer seam still gets the pool, honestly
        // capped at `settled-only` (persisted records alone).
        const liveObserver = scoped !== undefined && filter.fields === 'session' ? options.live?.() : undefined
        const requestDetails = scoped !== undefined && filter.fields === 'session'
          ? buildSessionRequestDetails({
            records: scoped,
            live: liveObserver?.snapshot(filter.sessionIds) ?? { attempts: [], activeCount: 0 },
            pricing: {
              resolve,
              rulesOf: name => context.ratesForModel(name),
              modelIdOf: name => context.resolveModel(name).modelId ?? name,
              ready: summary.costState === 'ready',
            },
            asOf: Date.now(),
            liveCapability: liveObserver?.capability ?? 'settled-only',
          })
          : undefined
        const payload = scoped !== undefined
          ? slimSessionPayload({
            summary,
            sessionIds: filter.sessionIds,
            series: requestSeriesOf(scoped, filter.from, filter.to, filter.model, canonical),
            currency,
            usdExchangeRate,
            fields: filter.fields,
            children,
            requestDetails,
            providerNames,
          })
          : {
            ...summaryRest,
            scope: 'whole' as const,
            sessionRows,
            projectRows: projectRowsOf(allSessionRows),
            currency,
            usdExchangeRate,
            ...(providerNames !== undefined ? { providerNames } : {}),
          } satisfies StatsPayload
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          // Stats change with every request; the browser must not cache them.
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }
}
