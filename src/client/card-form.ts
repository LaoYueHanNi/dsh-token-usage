/**
 * Staged form over the `token-usage` settings namespace's fields: the data
 * directory and the mirror region pick.
 *
 * A settings write is a durable, revision-fenced document mutation, so the
 * controls stage what the user picks and commit them only on save: what is on
 * screen is exactly what a save would store. Each field shows its effective
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

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { DirectoryGuardView } from '../wire.ts'
import { DIR_GUARD_PATH, MIGRATION_PATH } from '../wire.ts'

/** The fields this card edits. */
export const CARD_FIELDS = ['path', 'pricingRegion'] as const

/** One editable field of the token-usage settings section. */
export type CardField = typeof CARD_FIELDS[number]

/** The resolved user-facing section this card edits. */
export interface SectionValue {
  path?: string
  pricingRegion?: string
}

/** Live migration progress the card polls after saving a directory change. */
export interface MigrationView {
  /** Files finished so far. */
  done: number
  /** Total files this migration touches. */
  total: number
  /** Phase label for the progress line. */
  phase: 'copying' | 'cleaning'
}

/**
 * Minimal observable snapshot source: the stable-reference discipline the
 * shell's stores follow (same snapshot object until the fact moves), with
 * nothing the multi-field form does not use.
 */
export interface CardStore {
  /** @returns the current snapshot (stable reference until the next change). */
  getSnapshot(): CardState
  /** @param listener - invoked after each snapshot change. @returns the disposer. */
  subscribe(listener: () => void): () => void
  /** @param next - the new snapshot; replaces the reference only on a real change. */
  set(next: CardState): void
}

/**
 * Why the Host refused the last save, in a shape the card's locale renders.
 * The settings wire never delivers a refused write's reason (the bound scope
 * recovers silently and resolves), so the form asks the plugin's own guard
 * route and reports the verdict itself.
 */
export interface SaveRefusal {
  /** The mid-conversation veto on a directory change. */
  kind: 'sessions-interacting'
  /** Sessions mid-conversation at refusal time, for the notice's number. */
  interactingSessions: number
}

/** What the token-usage settings card renders. */
export interface CardState {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Draft text per field ('' marks the inherited/default option). */
  fields: Record<CardField, string>
  /** Whether saving each field would leave a user-layer entry. */
  overridden: Record<CardField, boolean>
  /** Whether the form holds an edit that a save would write. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
  /** The Host's refusal of the last save, when the guard named one; cleared
   * by the next edit or save. */
  refusal: SaveRefusal | undefined
  /** Migration progress while the Host relocates the data directory. */
  migration: MigrationView | undefined
}

/** The form actions the card's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  editField: (field: CardField, text: string) => void
  /** Stage a clear for one field, so saving lets it re-inherit the composition layer. */
  clearField: (field: CardField) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
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
export class CardForm {
  private snapshotValue: CardState
  private readonly listeners = new Set<() => void>()
  private drafts: Partial<Record<CardField, string>> = {}
  private saving = false
  private failed = false
  private refusal: SaveRefusal | undefined
  private migrationView: MigrationView | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined

  /**
   * @param scope - the bound settings scope for the `token-usage` namespace.
   */
  constructor(private readonly scope: SettingsScope<SectionValue>) {
    this.snapshotValue = this.project()
    scope.subscribe(() => { this.publish() })
    // A relocation another surface started (or one left over from a boot)
    // shows its progress here too.
    void this.pollMigration()
  }

  /** @returns the store the card's component reads through its bound selector. */
  bind(): CardStore {
    return {
      getSnapshot: () => this.snapshotValue,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      set: (next) => { this.store(next) },
    }
  }

  /** @returns the edit, clear, save, and discard actions bound to this form. */
  actions(): CardActions {
    return {
      editField: (field, text) => {
        this.drafts[field] = text
        this.failed = false
        this.refusal = undefined
        this.publish()
      },
      clearField: (field) => {
        this.drafts[field] = ''
        this.failed = false
        this.refusal = undefined
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        if (Object.keys(this.drafts).length === 0 && !this.failed) return
        this.drafts = {}
        this.failed = false
        this.refusal = undefined
        this.publish()
      },
    }
  }

  /**
   * Write the staged edits, then re-seed from what the Host accepted.
   *
   * The Host is the only authority on acceptance — an empty draft clears the
   * field, anything else stores the trimmed text (so blanking a control and
   * saving is the same gesture as clearing it). A save that did not land keeps
   * its drafts so the user can correct it instead of retyping. A landed save
   * that moved the data directory starts the migration poll: the Host
   * relocates as a two-phase commit and the card shows the file progress
   * until it settles.
   *
   * A staged directory edit is vetted through the plugin's guard route
   * before anything writes, and re-checked when the write did not land: the
   * settings wire swallows a refused write (the bound scope recovers
   * silently), so the guard is the only channel that can name the refusal —
   * otherwise the card could only say "did not land".
   */
  private async save(): Promise<void> {
    const edited = CARD_FIELDS.filter(field => this.drafts[field] !== undefined)
    if (edited.length === 0 || this.saving) return
    // Snapshot the intended writes: a keystroke mid-await must not change what
    // this save commits.
    const intended = edited.map(field => [field, this.drafts[field]!.trim()] as const)
    this.saving = true
    this.failed = false
    this.refusal = undefined
    this.publish()
    const pathEdit = intended.find(([field]) => field === 'path')
    if (pathEdit !== undefined) {
      const blocked = await this.guard(pathEdit[1])
      if (blocked !== undefined) {
        // Refused up front: nothing writes, the drafts stay staged, and the
        // notice says exactly what to end before saving again.
        this.saving = false
        this.failed = true
        this.refusal = blocked
        this.publish()
        return
      }
    }
    let landed = true
    try {
      for (const [field, text] of intended) {
        if (text === '') await this.scope.unset(field)
        else await this.scope.set(field, text)
      }
      // Read back: the Host's validators own the constraints no schema
      // expresses, so acceptance is judged from the stored layers.
      for (const [field, text] of intended) {
        if (text === '' ? this.stored(field) : this.storedValue(field) !== text) {
          landed = false
          break
        }
      }
    } catch (_settingsWriteFailure) {
      landed = false
    }
    // A directory write that did not land is usually the Host's validator
    // refusing between the pre-check and the write (a session started
    // mid-save); ask the guard again so the notice still names it.
    if (!landed && pathEdit !== undefined) {
      const blocked = await this.guard(pathEdit[1])
      if (blocked !== undefined) this.refusal = blocked
    }
    if (landed) {
      for (const [field, _text] of intended) delete this.drafts[field]
    }
    this.saving = false
    this.failed = !landed
    if (landed && intended.some(([field]) => field === 'path')) void this.pollMigration()
    this.publish()
  }

  /**
   * Ask the Host's guard route whether saving this directory would be refused
   * right now; a transport failure stays advisory (the write path's own
   * read-back still governs acceptance).
   * @param path - the staged path text ('' for the clear-to-default gesture).
   * @returns the refusal to show, or undefined when the save may proceed.
   */
  private async guard(path: string): Promise<SaveRefusal | undefined> {
    try {
      const response = await fetch(`${DIR_GUARD_PATH}?path=${encodeURIComponent(path)}`)
      if (!response.ok) return undefined
      const body = await response.json() as DirectoryGuardView
      if (body.blocked === true && typeof body.interactingSessions === 'number' && body.interactingSessions > 0) {
        return { kind: 'sessions-interacting', interactingSessions: body.interactingSessions }
      }
    } catch (_guardFailure) {
      // Unreachable guard: proceed to the write and let acceptance speak.
    }
    return undefined
  }

  /**
   * Poll the Host's migration endpoint until it answers null (no migration
   * running), publishing each progress step.
   */
  private async pollMigration(): Promise<void> {
    if (this.pollTimer !== undefined) return
    const tick = async (): Promise<void> => {
      let view: MigrationView | undefined
      try {
        const response = await fetch(MIGRATION_PATH)
        if (response.ok) {
          const body = await response.json() as MigrationView | null
          if (body !== null
            && (body.phase === 'copying' || body.phase === 'cleaning')
            && typeof body.done === 'number' && typeof body.total === 'number') {
            view = body
          }
        }
      } catch (_migrationPollFailure) {
        // The next tick retries; a transient read must not end the poll.
      }
      if (view === undefined && this.migrationView === undefined) {
        this.stopPolling()
        return
      }
      const settled = view === undefined
      if (settled) this.stopPolling()
      this.migrationView = view
      this.publish()
    }
    await tick()
    if (this.pollTimer === undefined && this.migrationView !== undefined) {
      this.pollTimer = setInterval(() => { void tick() }, 300)
    }
  }

  /** Stop the poll timer; the progress line leaves with the next publish. */
  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private snapshot(): SettingsScopeSnapshot<SectionValue> {
    return this.scope.getSnapshot()
  }

  /** The raw user layer narrowed to a record; the wire answer is `unknown`. */
  private userLayer(): Record<string, unknown> | undefined {
    const user = this.snapshot().user
    return typeof user === 'object' && user !== null ? user as Record<string, unknown> : undefined
  }

  private storedValue(field: CardField): unknown {
    return this.userLayer()?.[field]
  }

  private stored(field: CardField): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  /** The resolved (draft-free) text of one field; '' means inherited. */
  private effectiveOf(field: CardField): string {
    const value = this.snapshot().value?.[field]
    return typeof value === 'string' ? value : ''
  }

  /** The effective (draft-or-resolved) text of one field; '' means inherited. */
  private textOf(field: CardField): string {
    return this.drafts[field] ?? this.effectiveOf(field)
  }

  private project(): CardState {
    const snapshot = this.snapshot()
    const fields = {} as Record<CardField, string>
    const overridden = {} as Record<CardField, boolean>
    let dirty = false
    for (const field of CARD_FIELDS) {
      fields[field] = this.textOf(field)
      // A staged edit answers for itself, so the override badge previews the
      // save rather than reporting a state the pending edit contradicts.
      overridden[field] = this.drafts[field] !== undefined
        ? this.drafts[field]!.trim() !== ''
        : this.stored(field)
      if (this.drafts[field] !== undefined && this.drafts[field] !== this.effectiveOf(field)) {
        dirty = true
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
      refusal: this.refusal,
      migration: this.migrationView,
    }
  }

  /** Replace the snapshot reference and notify, only when the fact moved. */
  private store(next: CardState): void {
    if (next === this.snapshotValue) return
    this.snapshotValue = next
    for (const listener of this.listeners) listener()
  }

  private publish(): void {
    this.store(this.project())
  }
}
