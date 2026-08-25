/**
 * Provider credential + base-URL resolution (node half): the chain that
 * turns a provider ROUTE KEY into the material a quota adapter needs.
 *
 * The llm service never exposes keys or base URLs by design, so the chain
 * reads them from where the adapters themselves read them:
 * 1. the provider directory (`ctx.llm.listConfigurableProviders()`) maps a
 *    route to its settings namespace + path — with a built-in fallback for
 *    the two known shapes (pi-ai routes → `llm-pi-ai` `providers.<route>`;
 *    `deepseek-official` → the whole `llm-deepseek` section);
 * 2. the settings section at that path carries the profile
 *    (`{ apiKeyEnv, baseURL, … }`) — `apiKeyEnv` is a credential
 *    REFERENCE (an environment-variable name), never a value;
 * 3. the key resolves through the credentials seam (`credentials.resolve`),
 *    then a feature-detected `llm-pi-ai/<route>` record (newer hosts store
 *    the key the settings UI captured there), then the process env. The
 *    default env name comes from the profile, else pi-ai's per-route
 *    convention (`zai-coding-cn` → `ZAI_CODING_CN_API_KEY`, generic
 *    uppercase-dash-to-underscore otherwise).
 *
 * The base URL is the profile's `baseURL` override, else the built-in
 * catalog default for the known coding-plan routes — enough for host
 * matching (station choice) even though quota endpoints stay fixed.
 *
 * @module token-usage/quota/credentials
 */
/** The built-in directory fallback for the two known settings shapes. */
const BUILTIN_DIRECTORY = {
    'deepseek-official': { settingsNs: 'llm-deepseek', settingsPath: [] },
};
/** pi-ai route → default credential record key (`llm-pi-ai/<route>`). */
function recordKeyOf(provider) {
    return `llm-pi-ai/${provider}`;
}
/** pi-ai's per-route env-var convention for the routes we ship adapters
 * for; the generic mangling below covers everything else. */
const KNOWN_ENV_NAMES = {
    'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
    zai: 'ZAI_API_KEY',
    'kimi-coding': 'KIMI_API_KEY',
    'opencode-go': 'OPENCODE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
};
/** The generic env-name convention pi-ai applies: uppercase, every
 * non-alphanumeric run → `_` (`my-gateway` → `MY_GATEWAY_API_KEY`). */
function defaultEnvNameOf(provider) {
    return `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`;
}
/** The catalog base URLs of routes whose profiles carry no `baseURL` —
 * the inference endpoints the pi-ai catalog ships; quota adapters only
 * ever read the HOST off these. */
const CATALOG_BASE_URLS = {
    'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
    zai: 'https://api.z.ai/api/paas/v4',
    'kimi-coding': 'https://api.kimi.com/coding/v1',
    minimax: 'https://api.minimax.io/v1',
    'minimax-cn': 'https://api.minimaxi.com/v1',
    'opencode-go': 'https://opencode.ai/zen/go/v1',
};
/** Walk a settings section along a path; undefined as soon as a hop is
 * not an object holding the next key. */
function walkPath(section, path) {
    let current = section;
    for (const key of path) {
        if (typeof current !== 'object' || current === null)
            return undefined;
        current = current[key];
    }
    return current;
}
/** A string field off an unknown-shaped profile. */
function stringField(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/**
 * Resolve one provider route's quota credentials.
 * @param input - the route and the three seams (each optional; a missing
 * seam simply shortens the chain).
 * @returns the key material found and the resolvable base URL / name.
 */
export async function resolveQuotaCredentials(input) {
    const { provider } = input;
    // Directory entry: the host's llm service when injected, else the
    // built-in shapes (every non-deepseek route is a pi-ai settings dict key).
    const entry = input.directory?.(provider)
        ?? BUILTIN_DIRECTORY[provider]
        ?? { settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] };
    const profile = walkPath(input.readSettings(entry.settingsNs), entry.settingsPath);
    const record = typeof profile === 'object' && profile !== null ? profile : {};
    const apiKeyEnv = stringField(record.apiKeyEnv);
    const baseURL = stringField(record.baseURL);
    const ref = apiKeyEnv ?? KNOWN_ENV_NAMES[provider] ?? defaultEnvNameOf(provider);
    // Chain: credentials seam → pi-ai record store → process env. Each
    // layer is per-call by contract; no layer caches across queries.
    let apiKey;
    if (input.resolveCredential !== undefined) {
        apiKey = await input.resolveCredential(ref);
    }
    if (apiKey === undefined && input.readRecord !== undefined) {
        const stored = await input.readRecord(recordKeyOf(provider));
        apiKey = stringField(stored?.key);
    }
    if (apiKey === undefined) {
        apiKey = stringField(process.env[ref]);
    }
    return {
        ...(apiKey !== undefined ? { apiKey } : {}),
        apiKeyEnv: ref,
        ...(baseURL !== undefined ? { baseUrl: baseURL } : {}),
        ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
    };
}
/**
 * Layer the catalog default base URL under a resolution that found none —
 * the known coding-plan routes' catalog endpoints, so host-based adapter
 * matching works even when the profile omits `baseURL` (the common case:
 * pi-ai inherits the catalog silently).
 * @param provider - the route key.
 * @param resolved - the credential resolution (its `baseUrl` wins).
 * @returns the resolution with a catalog fallback base URL filled in.
 */
export function withCatalogBaseUrl(provider, resolved) {
    if (resolved.baseUrl !== undefined)
        return resolved;
    const fallback = CATALOG_BASE_URLS[provider];
    if (fallback === undefined)
        return resolved;
    return { ...resolved, baseUrl: fallback };
}
//# sourceMappingURL=credentials.js.map