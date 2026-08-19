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
/** The field this card edits. */
export const CARD_FIELDS = ['pricingRegion'];
/**
 * Stages the settings edits over the `token-usage` scope.
 *
 * The form publishes through a snapshot store because the slot component
 * reads through a snapshot selector while both the scope and the local drafts
 * change underneath; every projection is rebuilt from the two together. Only
 * fields the user touched are staged, so a save writes a sparse patch and
 * never restates fields it did not see.
 */
export class CardForm {
    scope;
    snapshotValue;
    listeners = new Set();
    drafts = {};
    saving = false;
    failed = false;
    /**
     * @param scope - the bound settings scope for the `token-usage` namespace.
     */
    constructor(scope) {
        this.scope = scope;
        this.snapshotValue = this.project();
        scope.subscribe(() => { this.publish(); });
    }
    /** @returns the store the card's component reads through its bound selector. */
    bind() {
        return {
            getSnapshot: () => this.snapshotValue,
            subscribe: (listener) => {
                this.listeners.add(listener);
                return () => { this.listeners.delete(listener); };
            },
            set: (next) => { this.store(next); },
        };
    }
    /** @returns the edit, clear, save, and discard actions bound to this form. */
    actions() {
        return {
            editField: (field, text) => {
                this.drafts[field] = text;
                this.failed = false;
                this.publish();
            },
            clearField: (field) => {
                this.drafts[field] = '';
                this.failed = false;
                this.publish();
            },
            save: () => { void this.save(); },
            discard: () => {
                if (Object.keys(this.drafts).length === 0 && !this.failed)
                    return;
                this.drafts = {};
                this.failed = false;
                this.publish();
            },
        };
    }
    /**
     * Write the staged edits, then re-seed from what the Host accepted.
     *
     * The Host is the only authority on acceptance — an empty draft clears the
     * field, anything else stores the trimmed text (so blanking a control and
     * saving is the same gesture as clearing it). A save that did not land keeps
     * its drafts so the user can correct it instead of retyping.
     */
    async save() {
        const edited = CARD_FIELDS.filter(field => this.drafts[field] !== undefined);
        if (edited.length === 0 || this.saving)
            return;
        // Snapshot the intended writes: a keystroke mid-await must not change what
        // this save commits.
        const intended = edited.map(field => [field, this.drafts[field].trim()]);
        this.saving = true;
        this.failed = false;
        this.publish();
        let landed = true;
        try {
            for (const [field, text] of intended) {
                if (text === '')
                    await this.scope.unset(field);
                else
                    await this.scope.set(field, text);
            }
            // Read back: the Host's validators own the constraints no schema
            // expresses, so acceptance is judged from the stored layers.
            for (const [field, text] of intended) {
                if (text === '' ? this.stored(field) : this.storedValue(field) !== text) {
                    landed = false;
                    break;
                }
            }
        }
        catch (_settingsWriteFailure) {
            landed = false;
        }
        if (landed) {
            for (const [field, _text] of intended)
                delete this.drafts[field];
        }
        this.saving = false;
        this.failed = !landed;
        this.publish();
    }
    snapshot() {
        return this.scope.getSnapshot();
    }
    /** The raw user layer narrowed to a record; the wire answer is `unknown`. */
    userLayer() {
        const user = this.snapshot().user;
        return typeof user === 'object' && user !== null ? user : undefined;
    }
    storedValue(field) {
        return this.userLayer()?.[field];
    }
    stored(field) {
        const user = this.userLayer();
        return user !== undefined && Object.hasOwn(user, field);
    }
    /** The resolved (draft-free) text of one field; '' means inherited. */
    effectiveOf(field) {
        const value = this.snapshot().value?.[field];
        return typeof value === 'string' ? value : '';
    }
    /** The effective (draft-or-resolved) text of one field; '' means inherited. */
    textOf(field) {
        return this.drafts[field] ?? this.effectiveOf(field);
    }
    project() {
        const snapshot = this.snapshot();
        const fields = {};
        const overridden = {};
        let dirty = false;
        for (const field of CARD_FIELDS) {
            fields[field] = this.textOf(field);
            // A staged edit answers for itself, so the override badge previews the
            // save rather than reporting a state the pending edit contradicts.
            overridden[field] = this.drafts[field] !== undefined
                ? this.drafts[field].trim() !== ''
                : this.stored(field);
            if (this.drafts[field] !== undefined && this.drafts[field] !== this.effectiveOf(field)) {
                dirty = true;
            }
        }
        return {
            available: snapshot.status === 'ready',
            writable: snapshot.writable,
            fields,
            overridden,
            dirty,
            saving: this.saving,
            failed: this.failed,
        };
    }
    /** Replace the snapshot reference and notify, only when the fact moved. */
    store(next) {
        if (next === this.snapshotValue)
            return;
        this.snapshotValue = next;
        for (const listener of this.listeners)
            listener();
    }
    publish() {
        this.store(this.project());
    }
}
//# sourceMappingURL=card-form.js.map