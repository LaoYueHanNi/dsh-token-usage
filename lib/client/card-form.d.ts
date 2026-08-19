/**
 * Staged form over the `token-usage` settings namespace's mirror region pick.
 *
 * A settings write is a durable, revision-fenced document mutation, so the
 * control stages what the user picks and commits it only on save: what is on
 * screen is exactly what a save would store. The field shows its effective
 * value (user layer over composition layer over schema default) and whether
 * the user layer carries it — key presence, not a value comparison, marks an
 * override. The namespace has no secret fields, so there is no write-only
 * control here.
 *
 * Self-contained on purpose: the client bundle-purity rule forbids value
 * imports across plugins, so this package stages and fences its own form
 * (and its own snapshot store) rather than importing the settings section's
 * shared model.
 *
 * @module token-usage/client/card-form
 */
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client';
/** The field this card edits. */
export declare const CARD_FIELDS: readonly ["pricingRegion"];
/** One editable field of the token-usage settings section. */
export type CardField = typeof CARD_FIELDS[number];
/** The resolved user-facing section this card edits. */
export interface SectionValue {
    pricingRegion?: string;
}
/**
 * Minimal observable snapshot source: the stable-reference discipline the
 * shell's stores follow (same snapshot object until the fact moves), with
 * nothing the multi-field form does not use.
 */
export interface CardStore {
    /** @returns the current snapshot (stable reference until the next change). */
    getSnapshot(): CardState;
    /** @param listener - invoked after each snapshot change. @returns the disposer. */
    subscribe(listener: () => void): () => void;
    /** @param next - the new snapshot; replaces the reference only on a real change. */
    set(next: CardState): void;
}
/** What the token-usage settings card renders. */
export interface CardState {
    /** False while the namespace is not served to this client; the card renders nothing. */
    available: boolean;
    /** Whether the Host document accepts writes. */
    writable: boolean;
    /** Draft text per field ('' marks the inherited/default option). */
    fields: Record<CardField, string>;
    /** Whether saving each field would leave a user-layer entry. */
    overridden: Record<CardField, boolean>;
    /** Whether the form holds an edit that a save would write. */
    dirty: boolean;
    /** Whether a save is crossing the wire. */
    saving: boolean;
    /** Whether the last save did not land as staged; cleared by the next edit or save. */
    failed: boolean;
}
/** The form actions the card's slot entry injects. */
export interface CardActions {
    /** Stage draft text for one field. */
    editField: (field: CardField, text: string) => void;
    /** Stage a clear for one field, so saving lets it re-inherit the composition layer. */
    clearField: (field: CardField) => void;
    /** Write every staged edit, then re-seed from what the Host accepted. */
    save: () => void;
    /** Drop every staged edit. */
    discard: () => void;
}
/**
 * Stages the settings edits over the `token-usage` scope.
 *
 * The form publishes through a snapshot store because the slot component
 * reads through a snapshot selector while both the scope and the local drafts
 * change underneath; every projection is rebuilt from the two together. Only
 * fields the user touched are staged, so a save writes a sparse patch and
 * never restates fields it did not see.
 */
export declare class CardForm {
    private readonly scope;
    private snapshotValue;
    private readonly listeners;
    private drafts;
    private saving;
    private failed;
    /**
     * @param scope - the bound settings scope for the `token-usage` namespace.
     */
    constructor(scope: SettingsScope<SectionValue>);
    /** @returns the store the card's component reads through its bound selector. */
    bind(): CardStore;
    /** @returns the edit, clear, save, and discard actions bound to this form. */
    actions(): CardActions;
    /**
     * Write the staged edits, then re-seed from what the Host accepted.
     *
     * The Host is the only authority on acceptance — an empty draft clears the
     * field, anything else stores the trimmed text (so blanking a control and
     * saving is the same gesture as clearing it). A save that did not land keeps
     * its drafts so the user can correct it instead of retyping.
     */
    private save;
    private snapshot;
    /** The raw user layer narrowed to a record; the wire answer is `unknown`. */
    private userLayer;
    private storedValue;
    private stored;
    /** The resolved (draft-free) text of one field; '' means inherited. */
    private effectiveOf;
    /** The effective (draft-or-resolved) text of one field; '' means inherited. */
    private textOf;
    private project;
    /** Replace the snapshot reference and notify, only when the fact moved. */
    private store;
    private publish;
}
//# sourceMappingURL=card-form.d.ts.map