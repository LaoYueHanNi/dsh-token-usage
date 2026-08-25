/**
 * The quota adapter registry (node half): the ordered table every provider
 * route resolves through. Adding a provider is one adapter file plus one
 * line here — see docs/decisions/proposed/0001-quota-provider-adapter.md.
 *
 * Adapters are mutually exclusive by construction (distinct hosts / route
 * keys), so order only breaks ties for a hypothetical overlap; keep the
 * coding plans ahead of the balance meters so a shared-host route prefers
 * the richer windows.
 *
 * @module token-usage/quota/registry
 */
import { deepseekBalanceAdapter } from "./adapters/deepseek-balance.js";
import { kimiAdapter } from "./adapters/kimi.js";
import { minimaxAdapter } from "./adapters/minimax.js";
import { opencodeGoAdapter } from "./adapters/opencode-go.js";
import { openrouterAdapter } from "./adapters/openrouter.js";
import { zhipuAdapter } from "./adapters/zhipu.js";
/** Every built-in adapter, most specific first. */
export const QUOTA_ADAPTERS = [
    zhipuAdapter,
    kimiAdapter,
    minimaxAdapter,
    opencodeGoAdapter,
    deepseekBalanceAdapter,
    openrouterAdapter,
];
/**
 * The adapter handling one provider route, or undefined when none does
 * (the `unsupported` payload variant). Resolution reads each adapter's
 * `matches` — host signal first, route key second; see the adapter docs.
 * @param input - the provider route key and its resolvable base URL.
 * @returns the owning adapter, or undefined.
 */
export function resolveQuotaAdapter(input) {
    return QUOTA_ADAPTERS.find(adapter => adapter.matches(input));
}
//# sourceMappingURL=registry.js.map