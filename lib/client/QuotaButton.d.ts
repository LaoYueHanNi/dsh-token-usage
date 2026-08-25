/**
 * Input-bar quota button (browser half): a 28×28 round trigger registered
 * into the `conversation.input.right` slot (it renders left of the model
 * chip — the host's fixed tool-row order). The glyph is a remaining-share
 * ring (ContextMeter family) colored by the finest window. Clicking opens a
 * width-tiered popup (amount-only 200px / one progress bar 232px / two
 * bars 320px) centered on the button with the current provider's quota
 * windows: progress columns (5 小时 / 每周) for coding-plan providers, an
 * amount row for balance providers.
 *
 * The provider follows the model CHIP's live selection (the shell's
 * model-selection service reports the host's next selection before any
 * request is sent); without that service the host falls back to the last
 * request's provider, else the default selection.
 *
 * The button SELF-GATES: it renders nothing while the host cannot
 * determine a provider (`no-provider`), the provider has no quota adapter
 * (`unsupported`), or the feature is off (`disabled`) — switching
 * providers makes it appear again. A supported provider whose query fails
 * KEEPS the button and shows the error with a retry inside the panel.
 *
 * The interaction copies ContextMeter verbatim (click toggles, document
 * pointerdown outside closes, Escape closes); mutual exclusion with the
 * ContextMeter panel falls out of both components' outside-close
 * handlers — opening one closes the other on its next pointerdown.
 *
 * @module token-usage/client/QuotaButton
 */
import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * Structural view of the shell's model-selection service
 * (`ctx.modelDirectories`, owned by ui-model-selection) — the same shared
 * per-session directory the model chip renders from. Structural on
 * purpose: no value import across plugins, and no compile-time tie to a
 * package version the shell may or may not carry.
 */
export interface ModelSelectionSource {
    /** The session's shared directory (throws when the session resolves no scope). */
    directoryFor(sessionId: string): {
        /** The host-reported selection for the NEXT assembled step; null before the first load. */
        store: {
            getSnapshot(): {
                current: {
                    provider: string;
                } | null;
            };
            subscribe(fn: () => void): () => void;
        };
    };
}
/** Stable holder the registration injects; the service attaches late (optional inject). */
export interface ModelDirectoryHandle {
    readonly service: ModelSelectionSource | undefined;
}
/** Props the quota button binds for the conversation input-right slot. */
export type QuotaButtonProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'token-usage'> & {
    modelDirectory?: ModelDirectoryHandle;
};
/**
 * Render the input-bar quota button for the active session's provider.
 * @param props - the framework session id, the locale seat, and the
 * optional model-directory holder (the chip's live selection).
 * @returns the trigger + panel, or null while hidden (see the module note).
 */
export declare function QuotaButton({ sessionId, t, modelDirectory }: QuotaButtonProps): ReactNode | null;
//# sourceMappingURL=QuotaButton.d.ts.map