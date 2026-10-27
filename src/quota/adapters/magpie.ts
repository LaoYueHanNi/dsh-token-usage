/**
 * Magpie gateway adapter: the aggregated quota cards of every upstream
 * account the local magpie gateway holds, read through its read-only
 * `GET /v1/magpie/quotas?kept=1` report. Only the gateway's last read is
 * consumed: polling, opening and retrying never ask vendors to refresh.
 *
 * Identity is PROBED, not assumed: a magpie route is a user-declared
 * OpenAI-compatible profile with an arbitrary name and a loopback-ish
 * base URL no host table can enumerate. The adapter claims the `magpie`
 * route key directly; every other unknown route is resolved by
 * {@link MagpieDetector} (the gateway's `GET /v1` hello answers
 * `{"name":"magpie"}`), which the quota service consults when the
 * registry finds nothing — see quota-service.ts.
 *
 * Model scoping: magpie's model ids are `provider/model`, so the model
 * the asking session uses names the card(s) to show — the account(s) of
 * that provider, several when the user signed in more than one. A
 * routing group id (`group/…`, whose members the gateway does not list
 * over REST) and a bare model id scope to NOTHING, and an unmatched
 * prefix falls back to the whole fleet: a group may route anywhere, and
 * the full card list is what the user arranged the gateway around.
 *
 * Window vocabulary: magpie reports open-named windows ("5 hours",
 * "Weekly", "7 days · Opus", "Credits", "Allowance") with used shares in
 * percent; the known period names map onto the wire's tiers, the rest
 * ride as `other` windows carrying the vendor's own name. Balances are
 * sign-prefixed money strings ("¥356.81", "$11.12 · ¥-0.05" when a
 * vendor reports two currencies) — the first amount parses, its sign
 * naming the currency.
 *
 * @module token-usage/quota/adapters/magpie
 */

import type { QuotaWindow } from '../../wire.ts'
import { fetchJson } from '../http.ts'
import type { QuotaAdapter, QuotaQueryResult } from '../types.ts'
import { QuotaQueryError } from '../types.ts'

/** The route key that claims this adapter outright (no probe needed). */
export const ROUTE_MAGPIE = 'magpie'
/** The gateway's default listen address, used when the profile carries no
 * base URL (the `magpie` route key with a bare profile). */
export const DEFAULT_MAGPIE_BASE = 'http://127.0.0.1:3425/v1'

/** Transport ceiling only; kept reads never wait for vendor fan-out. */
const MAGPIE_QUERY_TIMEOUT_MS = 15_000

/**
 * The gateway root a base URL points at: trailing slashes trimmed, and a
 * bare origin (no `/v1` tail) kept as-is — magpie mounts its API at the
 * root, so both `http://host:3425` and `http://host:3425/v1` are valid
 * client base URLs and every endpoint path is appended verbatim.
 */
export function magpieBaseOf(baseUrl: string | undefined): string {
  const base = baseUrl !== undefined && baseUrl !== '' ? baseUrl : DEFAULT_MAGPIE_BASE
  return base.replace(/\/+$/u, '')
}

/** The quota report URL of one gateway base. */
export function magpieQuotaUrl(baseUrl: string | undefined): string {
  const base = magpieBaseOf(baseUrl)
  return /\/v1$/u.test(base) ? `${base}/magpie/quotas?kept=1` : `${base}/v1/magpie/quotas?kept=1`
}

/** One `data[]` card of the report, structurally typed. `cardLabel` is
 * the display title the query stamps as it walks the cards (plan and
 * multi-account qualifiers attached), not a field the report carries. */
interface MagpieCard {
  provider: string
  name: string
  kind: string
  plan?: string
  user?: string
  windows: Array<{
    name?: string
    used?: number
    resetsAt?: string
    unlimited?: boolean
  }>
  balance?: string
  error?: string
  cardLabel?: string
}

/** Parse the `data[]` array out of the report envelope. */
function cardsOf(body: unknown): MagpieCard[] {
  if (typeof body !== 'object' || body === null) {
    throw new QuotaQueryError('parse', 'response is not an object')
  }
  const data = (body as Record<string, unknown>).data
  if (!Array.isArray(data)) {
    throw new QuotaQueryError('parse', 'missing "data" array')
  }
  const cards: MagpieCard[] = []
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider === '') continue
    cards.push({
      provider: record.provider,
      name: typeof record.name === 'string' ? record.name : record.provider,
      kind: typeof record.kind === 'string' ? record.kind : '',
      ...(typeof record.plan === 'string' && record.plan !== '' ? { plan: record.plan } : {}),
      ...(typeof record.user === 'string' && record.user !== '' ? { user: record.user } : {}),
      windows: Array.isArray(record.windows)
        ? record.windows.filter((w): w is MagpieCard['windows'][number] =>
          typeof w === 'object' && w !== null)
        : [],
      ...(typeof record.balance === 'string' ? { balance: record.balance } : {}),
      ...(typeof record.error === 'string' && record.error !== '' ? { error: record.error } : {}),
    })
  }
  return cards
}

/** The wire tier of one magpie window name, or `other` (the vendor's own
 * name rides along on the window). The gateway normalizes its vendors to
 * a small set of period names — "5 hours", "Weekly", "7 days" (at times
 * suffixed "· Opus" when a model draws its own weekly pool), "Monthly" /
 * "Month" — everything else is a meter the tier vocabulary has no slot
 * for and stays itself. */
function tierOfWindow(name: string | undefined): 'five_hour' | 'weekly' | 'monthly' | 'other' {
  const lower = name?.toLowerCase() ?? ''
  if (/^5\s*h(ou?rs?)?$/u.test(lower)) return 'five_hour'
  if (/^(weekly|7\s*days?\b)/u.test(lower)) return 'weekly'
  if (/^month(ly)?$/u.test(lower)) return 'monthly'
  return 'other'
}

/** The first sign-prefixed money amount of a balance string and its
 * currency ("¥356.81" → cny, "$11.12 · ¥-0.05" → usd 11.12), or
 * undefined when no money parses. Sign-less figures are refused: the
 * gateway also formats non-money counts ("12.3k credits") the same way,
 * and only the sign says which is money. */
function balanceOf(text: string | undefined): { value: number; unit: 'usd' | 'cny' } | undefined {
  if (text === undefined) return undefined
  const match = text.match(/([¥$])\s*(-?[\d,]+(?:\.\d+)?)/u)
  if (match === null) return undefined
  const value = Number(match[2]?.replace(/,/gu, ''))
  if (!Number.isFinite(value)) return undefined
  return { value, unit: match[1] === '$' ? 'usd' : 'cny' }
}

/**
 * The provider id prefix of a model id (`zcode/glm-4.7` → `zcode`), or
 * undefined when the id names no provider: a routing group
 * (`group/…` — the members are the user's to arrange and are not listed
 * over REST) and a bare id both scope to the whole fleet.
 */
function providerPrefixOf(model: string | undefined): string | undefined {
  if (model === undefined || model === '') return undefined
  const slash = model.indexOf('/')
  if (slash <= 0) return undefined
  const prefix = model.slice(0, slash)
  if (prefix.toLowerCase() === 'group') return undefined
  return prefix
}

/** One normalized window of a card's report windows. */
function windowOf(card: MagpieCard, span: MagpieCard['windows'][number]): QuotaWindow | undefined {
  const used = typeof span.used === 'number' && Number.isFinite(span.used) && span.used >= 0
    ? Math.min(span.used, 100)
    : undefined
  if (used === undefined) return undefined
  const tier = tierOfWindow(span.name)
  const resetAt = span.resetsAt !== undefined ? Date.parse(span.resetsAt) : Number.NaN
  const pool = poolOf(card)
  return {
    tier,
    usedPercent: used,
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    ...(tier === 'other' && span.name !== undefined ? { name: span.name } : {}),
    ...(card.cardLabel !== undefined ? { card: card.cardLabel } : {}),
    ...(pool !== undefined ? { pool } : {}),
  }
}

/**
 * The quota POOL of one card: the vendor identity (route key + display
 * name) its windows draw on. Several cards of the SAME vendor — several
 * keys, several accounts, even several plans of that vendor — share that
 * pool: the gateway routes that vendor's traffic to whichever account
 * still has room, so their budgets are interchangeable and the pool's
 * water level is the meaningful one.
 *
 * The PLAN deliberately does NOT join the identity: a lite plan and a pro
 * plan are separately metered, yet the gateway treats both as accounts of
 * the same vendor and shifts traffic between them (their `lastServedAt`
 * stamps alternate) — for the question the ring answers ("can I still
 * use this vendor?"), they are one budget. Cards of DIFFERENT vendors
 * never share a pool: their same-named windows are unrelated budgets and
 * must not be averaged together.
 */
function poolOf(card: MagpieCard): string | undefined {
  if (card.provider === '' || card.name === '') return undefined
  return `${card.provider}::${card.name}`
}

/**
 * The magpie gateway adapter. One query answers the cards the asking
 * model draws on — see the module note for the scoping rules.
 */
export const magpieAdapter: QuotaAdapter = {
  id: 'magpie-quotas',
  label: 'Magpie',
  routes: [ROUTE_MAGPIE],
  queryTimeoutMs: MAGPIE_QUERY_TIMEOUT_MS,
  // The loopback gateway serves its quota report without any key; a key
  // matters only for a shared gateway on another machine (where its
  // absence surfaces as an auth error with a retry, not a hidden button).
  usesApiKey: false,
  matches(input) {
    return input.provider === ROUTE_MAGPIE
  },
  async query(ctx): Promise<QuotaQueryResult> {
    const headers: Record<string, string> = {}
    if (ctx.apiKey !== '') headers.authorization = `Bearer ${ctx.apiKey}`
    const cards = cardsOf(await fetchJson(ctx, magpieQuotaUrl(ctx.baseUrl), headers))
    if (cards.length === 0) {
      throw new QuotaQueryError('parse', 'no quota cards in "data"')
    }

    // Failed reads are cards too (their windows empty, their error set):
    // drop them while any healthy card remains, but an all-error report
    // is the gateway saying the read failed — surface it, not an empty
    // success.
    const healthy = cards.filter(card => card.error === undefined)
    if (healthy.length === 0) {
      throw new QuotaQueryError('http', cards[0]?.error ?? 'every card failed to read')
    }

    // Scope to the asking model's provider when the prefix names a card
    // the report actually holds; otherwise (group, bare id, provider
    // without a card) the whole fleet answers.
    const prefix = providerPrefixOf(ctx.model)
    let scoped = healthy
    if (prefix !== undefined) {
      const matches = healthy.filter(card =>
        card.provider === prefix || card.provider.startsWith(`${prefix}/`))
      if (matches.length > 0) scoped = matches
    }

    // A provider with several cards (two accounts of one vendor, several
    // keys) needs each card distinguishable: the account name rides
    // along, a blank one numbered by position.
    const byProvider = new Map<string, number>()
    for (const card of scoped) byProvider.set(card.provider, (byProvider.get(card.provider) ?? 0) + 1)
    let unnamed = 0
    const windows: QuotaWindow[] = []
    for (const card of scoped) {
      const multi = (byProvider.get(card.provider) ?? 0) > 1
      let label = card.plan !== undefined ? `${card.name} · ${card.plan}` : card.name
      if (multi) {
        unnamed = card.user !== undefined ? unnamed : unnamed + 1
        label += ` · ${card.user ?? `#${String(unnamed)}`}`
      }
      card.cardLabel = label
      const pool = poolOf(card)
      if (card.kind === 'balance') {
        const balance = balanceOf(card.balance)
        if (balance === undefined) continue
        windows.push({
          tier: 'balance',
          remainingValue: balance.value,
          unit: balance.unit,
          card: label,
          ...(pool !== undefined ? { pool } : {}),
        })
        continue
      }
      for (const span of card.windows) {
        const window = windowOf(card, span)
        if (window !== undefined) windows.push(window)
      }
    }
    if (windows.length === 0) {
      throw new QuotaQueryError('parse', 'no windows or balances in the report cards')
    }
    return { windows }
  },
}

/**
 * The magpie gateway detector: decides whether a base URL points at a
 * magpie, caching both verdicts so the unsupported-path poll the panel
 * keeps running never hammers the probe. The gateway answers every
 * OpenAI-compatible hello (`GET /` and `GET /v1`) with
 * `{"name":"magpie","version":…}` — a handshake it maintains precisely
 * so clients can feature-detect it.
 */
export class MagpieDetector {
  readonly #cache = new Map<string, { at: number; hit: boolean }>()
  readonly #now: () => number

  /** @param now - clock seam; tests freeze it. */
  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** How long a POSITIVE verdict stays authoritative (the gateway is not
   * going to stop being one). */
  static readonly HIT_TTL_MS = 10 * 60_000
  /** How long a NEGATIVE verdict holds — short, so a gateway that comes
   * up between polls is found on the next one. */
  static readonly MISS_TTL_MS = 2 * 60_000

  /**
   * Whether the base URL answers magpie's hello.
   * @param input - the base URL (undefined reads the default gateway),
   * the transport, and the optional gateway key (a shared gateway on
   * another machine requires it; the loopback one does not mind).
   */
  async detect(input: {
    baseUrl?: string
    apiKey?: string
    fetchFn: typeof fetch
    signal?: AbortSignal
  }): Promise<boolean> {
    const base = magpieBaseOf(input.baseUrl)
    const cached = this.#cache.get(base)
    const ttl = cached?.hit === true ? MagpieDetector.HIT_TTL_MS : MagpieDetector.MISS_TTL_MS
    if (cached !== undefined && this.#now() - cached.at < ttl) return cached.hit

    const headers: Record<string, string> = {}
    if (input.apiKey !== undefined && input.apiKey !== '') headers.authorization = `Bearer ${input.apiKey}`
    let hit = false
    try {
      const body = await fetchJson(
        {
          provider: ROUTE_MAGPIE,
          apiKey: '',
          fetchFn: input.fetchFn,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        base,
        headers,
      )
      hit = typeof body === 'object' && body !== null
        && (body as Record<string, unknown>).name === 'magpie'
    } catch {
      hit = false
    }
    this.#cache.set(base, { at: this.#now(), hit })
    return hit
  }
}
