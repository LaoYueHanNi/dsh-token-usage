/**
 * The token-usage card on the Plugins configuration tab: a collapsible row
 * whose header names the plugin over a one-line description of what its
 * settings govern, disclosing the data-directory control and the mirror
 * region pick (`domestic` gitee / `overseas` github) when open. The card owns
 * everything inside it — chrome, controls, and copy — per the keyed-slot
 * contract; the tab only dispatches it under the `token-usage` namespace key.
 *
 * Renders nothing while the namespace is unavailable: a deployment that did
 * not compose the host half shows no trace of the card. A region change takes
 * effect live (the host re-syncs the pricing mirror); a directory change the
 * guard refuses while conversations run shows the wait-for-them notice on the
 * failure line, and one that lands migrates the data across under a live
 * progress bar that locks the controls until it settles.
 *
 * @module token-usage/client/TokenUsageCard
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CardActions, CardStore } from './card-form.ts';
/** Props the renderer binds for the token-usage settings card. */
export type TokenUsageCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'token-usage'> & InjectFace<TokenUsageCardFace>;
/** The registration-side face this card's slot entry injects. */
export interface TokenUsageCardFace extends CardActions {
    hooks: {
        /** Card snapshot bound by the renderer as useTokenUsageCard. */
        tokenUsageCard: CardStore;
    };
    /**
     * The shell's native directory picker (the workspace flows' chooser):
     * resolves the chosen absolute path, or null when the user dismisses the
     * dialog.
     */
    pickDirectory: () => Promise<string | null>;
}
/**
 * Render the token-usage settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export declare function TokenUsageCard(props: TokenUsageCardProps): import("react").JSX.Element | null;
//# sourceMappingURL=TokenUsageCard.d.ts.map