/**
 * Browser half of the token-usage plugin. Two registrations share one
 * dictionary pair: the Token Usage stats page on the settings surface (data
 * from the host half's stats route, `/token-usage/stats`), and the plugin
 * configuration card on the Plugins tab (the `token-usage` settings
 * namespace — the data directory and the pricing region — edited through
 * the settings scope, with the relocation progress polled from
 * `/token-usage/migration`). The card's browse button rides the shell's
 * workspace navigation service (`ctx.uiWorkspace.pickDirectory`), the same
 * native directory picker the workspace flows use. Export discipline: the
 * /client entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */

// dsh 0.1.2 removed dsh-client-runtime; its ClientContext was a plain alias
// of the cordis Context, so the type now comes from cordis directly.
// Type-only: pulls the ctx.slots declaration merge (owned by ui-renderer,
// whose published types no longer re-declare it through ui-session).
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ctx.uiWorkspace (directory picker) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the ui-settings SlotMap merge ('settings.section') and the
// owner-share type into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-settings-plugins keyed-slot declaration
// ('settings.plugin.item') into this program. The value face stays
// uncompromised: cross-plugin collaboration goes through the slot system.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * A bundle's own configuration on the Plugins page, keyed by package name.
     */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: { readonly view: 'summary' | 'page' } }
  }
}
// Type-only: pulls the ui-conversation SlotMap merge ('conversation.view')
// so the Usage view tab registers against the same slot the Chat and
// Trajectory tabs live in. No runtime import — the slot service provides
// the standard kit (useSession/useSessions/useProjection/sessionId).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale service's Context merge (ctx.locale) and the
// shared `common` vocabulary into the `t` seat's key domain.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CardForm, createFallbackTarget, type CardFormTarget, type SectionValue } from './card-form.ts'
import { QuotaButton, type ModelSelectionSource } from './QuotaButton.tsx'
import { SessionStatsChip } from './SessionStatsChip.tsx'
import { TokenUsageCard } from './TokenUsageCard.tsx'
import { TokenUsageSection } from './TokenUsageSection.tsx'
import { UsageView } from './UsageView.tsx'
import { en, NS, zh } from './locales.ts'

/**
 * Namespace of the token-usage settings section. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
const TOKEN_USAGE_NS = 'token-usage'

/**
 * Candidate keys under which the Host may serve this plugin's settings
 * form. The 0.1.7 host keys `ConfigForms.get` by the plugin's ENTRY ID (the
 * namespace); the full package name stays as a fallback for a host that keyed
 * it by package instead.
 */
const CONFIG_FORM_KEYS = [TOKEN_USAGE_NS, '@laoyuehanni/dsh-token-usage'] as const

/** Minimal describe-mirror face: the served namespaces, subscription, first read. */
interface DescribeMirrorLike {
  getSnapshot(): { view?: { namespaces?: ReadonlyArray<{ ns: string }> } }
  subscribe(listener: () => void): () => void
  ensure?(): Promise<void>
}

/** The `configForms` service face as this plugin consumes it. */
interface ConfigFormsLike {
  /** Entry-id keyed form controller; the 0.1.7 host NEVER returns undefined. */
  get<T>(entryId: string): CardFormTarget<T>
  /** The shared describe mirror the forms derive from. */
  describe?(): DescribeMirrorLike | undefined
}

/**
 * Resolve the form target from the describe mirror's LIVE namespace list.
 * The 0.1.7 `ConfigForms.get()` unconditionally creates and caches a
 * controller for ANY key — it never returns undefined — so key validity must
 * come from the namespaces the mirror actually serves. A `get()` on a key the
 * mirror does not list yields a controller stuck at 'unavailable' forever,
 * and the card renders nothing. No view yet (mirror still loading) answers
 * undefined so the caller keeps its current target.
 */
const resolveConfigFormsTarget = (forms: ConfigFormsLike): CardFormTarget<SectionValue> | undefined => {
  const namespaces = typeof forms.describe === 'function'
    ? forms.describe()?.getSnapshot()?.view?.namespaces
    : undefined
  if (namespaces === undefined) return undefined
  const served = CONFIG_FORM_KEYS.find(key => namespaces.some(row => row.ns === key))
  return served === undefined ? undefined : forms.get<SectionValue>(served)
}

/** Required services: the slot registry, the locale dictionaries, the
 * workspace navigation service (its native directory picker backs the card's
 * browse button), and the session controller (the stats page's Ctrl+click
 * session jump reads the list and opens the target). Configuration sources
 * (`configForms` in dsh 0.1.7+, `settingsScope` in pre-0.1.7) attach dynamically. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'uiWorkspace', 'sessions']

/**
 * Register the dictionary pair, then the settings page and the plugin
 * configuration card once the shell's declarations are on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-usage: dictionaries')
  // Stable per-namespace translate reading the active locale at call time;
  // the label thunk re-evaluates it per read, so the nav row follows switches.
  const t = ctx.locale.bind(NS)
  // The stats page's session jump is parked for the dsh 0.1.7 session
  // controller: ISessions.open (the old navigation entry point) is gone —
  // retention is the new acquisition shape and navigation belongs to view
  // owners — and no drop-in replacement is wired yet. Both predicates
  // answer false so the page renders no jump affordance and refuses the
  // click, keeping the hint and the behavior in sync until the jump
  // returns.
  const sessionListed = (_id: string): boolean => false
  const openSession = (_id: string): boolean => false
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'token-usage',
    order: 50,
    label: () => t('nav.label'),
    locale: NS,
    inject: () => ({ sessionListed, openSession }),
  }, TokenUsageSection))

  // The Usage view tab: one entry of the conversation view ring (beside the
  // built-in Chat tab and the Trajectory tab from ui-trajectory, rendered
  // by the session header's tab ring, one at a time). Registration is the
  // same trajectory pattern — a label thunk follows the active locale, and
  // the component reads the session through the standard kit.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'usage',
    order: 20,
    label: () => t('view.usage'),
    locale: NS,
  }, UsageView))

  // The session-header stats chip: one entry of the
  // `conversation.session.header.utilities` slot list (right-aligned
  // utilities kept outside the title-adjacent action group). The chip
  // reads the active session id and the session-list mirror from the
  // standard kit, walks the subagent subtree, and fetches the folded
  // summary from the host's `/token-usage/stats` route — the same
  // "with subagents" range the Usage view tab offers. The component
  // self-gates: a session with zero recorded requests renders nothing
  // (the spec's empty rule); a transient fetch miss keeps the previous
  // render so the chip never blanks to "—" mid-conversation.
  //
  // Position: the chip sits IMMEDIATELY LEFT of the Session log button
  // (`session-log-download` registers with no explicit `order`, defaulting
  // to 0). A negative order puts the chip ahead of every positive-order
  // utility, mirroring the convention `ui-agent-preset` uses for static
  // session context in `conversation.session.header.actions`.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-stats',
    order: -10,
    locale: NS,
  }, SessionStatsChip))

  // The input-bar quota button: one entry of the `conversation.input.right`
  // slot list (the tool row's right end, before the send button — the host
  // renders slot entries left of the model chip). The button polls the
  // host's `/token-usage/quota` route for the ACTIVE session's provider and
  // self-gates: it renders nothing while the provider is undeterminable or
  // has no quota adapter, so the toolbar stays clean on unsupported
  // providers and the button reappears when a supported one takes over.
  // `order: 10` keeps it after any future lower-order utilities in the
  // same slot.
  //
  // Provider resolution follows the model CHIP: the shell's model-selection
  // service (`ctx.modelDirectories`, from ui-model-selection — the same
  // shared per-session directory the chip renders from) reports the host's
  // NEXT selection live, so the button appears the moment the user picks a
  // provider, before any request is sent. The service attaches through an
  // OPTIONAL inject — a shell without it falls back to the host's own
  // resolution (last request's provider, else the default selection).
  const modelDirectory: { service: ModelSelectionSource | undefined } = { service: undefined }
  ctx.inject(['modelDirectories'], (modelCtx) => {
    modelCtx.effect(() => {
      modelDirectory.service = (modelCtx as unknown as { modelDirectories?: ModelSelectionSource }).modelDirectories
      return () => { modelDirectory.service = undefined }
    }, 'token-usage: model directory seam')
  })
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'token-usage-quota',
    order: 10,
    locale: NS,
    inject: () => ({ modelDirectory }),
  }, QuotaButton))

  // Configuration source resolution:
  // - dsh 0.1.7+: ctx.configForms provides ConfigForm (keyed by the entry id
  //   the describe mirror actually serves; see resolveConfigFormsTarget)
  // - pre-0.1.7: ctx.settingsScope provides SettingsScope (bound by namespace)
  // - fallback: unavailable target preventing runtime errors if neither is mounted
  const lookupCurrentTarget = (): CardFormTarget<SectionValue> | undefined => {
    const configForms = ctx.get('configForms') as ConfigFormsLike | undefined
    if (configForms && typeof configForms.get === 'function') {
      const byMirror = resolveConfigFormsTarget(configForms)
      if (byMirror !== undefined) return byMirror
    }
    const settingsScope = ctx.get('settingsScope') as {
      bind<T>(options: { namespace: string }): CardFormTarget<T>
    } | undefined
    if (settingsScope && typeof settingsScope.bind === 'function') {
      return settingsScope.bind<SectionValue>({ namespace: TOKEN_USAGE_NS })
    }
    return undefined
  }

  const initialTarget = lookupCurrentTarget()
  let activeTarget: CardFormTarget<SectionValue> = initialTarget ?? createFallbackTarget()
  const targetListeners = new Set<() => void>()
  let unsubActive: (() => void) | undefined = activeTarget.subscribe(() => {
    for (const listener of targetListeners) listener()
  })

  const switchTarget = (next: CardFormTarget<SectionValue>): void => {
    if (next === activeTarget) return
    unsubActive?.()
    activeTarget = next
    unsubActive = activeTarget.subscribe(() => {
      for (const listener of targetListeners) listener()
    })
    for (const listener of targetListeners) listener()
  }

  ctx.inject(['configForms'], (configCtx) => {
    configCtx.effect(() => {
      const forms = configCtx.get('configForms') as ConfigFormsLike | undefined
      if (!forms || typeof forms.get !== 'function') return () => {}
      // The describe mirror loads asynchronously (its first snapshot holds no
      // view), so besides resolving now, follow the mirror: the moment the
      // namespace appears — or the host re-keys it — re-resolve and bind.
      const mirror = typeof forms.describe === 'function' ? forms.describe() : undefined
      const resolve = (): void => {
        const target = resolveConfigFormsTarget(forms)
        if (target !== undefined) switchTarget(target)
      }
      resolve()
      void mirror?.ensure?.()
      const unsubscribe = mirror?.subscribe(() => { resolve() })
      return () => { unsubscribe?.() }
    }, 'token-usage: configForms dynamic target')
  })

  ctx.inject(['settingsScope'], (scopeCtx) => {
    scopeCtx.effect(() => {
      const scopeService = scopeCtx.get('settingsScope') as {
        bind<T>(options: { namespace: string }): CardFormTarget<T>
      } | undefined
      if (scopeService && typeof scopeService.bind === 'function') {
        switchTarget(scopeService.bind<SectionValue>({ namespace: TOKEN_USAGE_NS }))
      }
      return () => {}
    }, 'token-usage: settingsScope dynamic target')
  })

  const dynamicTarget: CardFormTarget<SectionValue> = {
    getSnapshot: () => activeTarget.getSnapshot(),
    subscribe: (listener) => {
      targetListeners.add(listener)
      return () => { targetListeners.delete(listener) }
    },
    set: (field, value) => activeTarget.set(field, value),
    unset: (field) => activeTarget.unset(field),
  }

  // The Plugins page dispatches keyed configuration for bundles through
  // `plugins.bundle.config` (keyed by the bundle's package name).
  const form = new CardForm(dynamicTarget)
  const store = form.bind()
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@laoyuehanni/dsh-token-usage',
    locale: NS,
    inject: () => ({
      hooks: { tokenUsageCard: store },
      ...form.actions(),
      // The shell's own directory picker (the workspace flows' chooser):
      // resolves the chosen absolute path, or null when the user dismisses.
      pickDirectory: () => (ctx.get('uiWorkspace') as {
        pickDirectory?: () => Promise<string | null>
      } | undefined)?.pickDirectory?.() ?? Promise.resolve(null),
    }),
  }, TokenUsageCard))
}
