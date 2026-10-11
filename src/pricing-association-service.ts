import { randomUUID } from 'node:crypto'
import { modelKey } from './model-resolution.ts'
import { readPricingContext, readPricingContextLocked, type PricingContext } from './pricing.ts'
import { AssociationError, associationWritesPaused, exactFields, isAssociationName, pricingDirectoryKey, withPricingDirectoryWrite, writeAssociations } from './pricing-associations.ts'
import { consoleLogger, type LoggerLike } from './log.ts'
import type { DeletePricingAssociation, PricingAssociationsPayload, SavePricingAssociation } from './wire.ts'

/** Directory epochs reject forms from an earlier directory, including a
 * round-trip back to the same path after migration. */
export class PricingAssociationService {
  private directoryKey = ''
  private directoryToken = randomUUID()

  constructor(private readonly directory: () => string, private readonly logger: LoggerLike = consoleLogger) {}

  directoryChanged(): void {
    this.directoryKey = pricingDirectoryKey(this.directory())
    this.directoryToken = randomUUID()
  }

  private capture(): { dir: string; token: string } {
    const dir = this.directory()
    if (pricingDirectoryKey(dir) !== this.directoryKey) this.directoryChanged()
    return { dir, token: this.directoryToken }
  }

  private verify(token: string): void {
    if (this.capture().token !== token) throw new AssociationError('directory-conflict')
  }

  private payload(context: PricingContext, token: string, sourceModel?: string): PricingAssociationsPayload {
    return {
      ...(context.feedVersion !== undefined ? { feedVersion: context.feedVersion } : {}),
      directoryToken: token,
      revision: context.associations.state === 'ready' ? context.associations.file.revision : null,
      storageState: context.associations.state,
      ...(context.associations.state === 'unavailable' ? { storageError: context.associations.error } : {}),
      pricingAvailable: context.available,
      ...(context.unavailableReason !== undefined ? { pricingUnavailableReason: context.unavailableReason } : {}),
      writesPaused: associationWritesPaused(this.directory()),
      associations: [...context.associationStatuses].sort((a, b) => modelKey(a.sourceModel).localeCompare(modelKey(b.sourceModel))),
      ...(sourceModel !== undefined ? { resolution: context.resolveModel(sourceModel) } : {}),
    }
  }

  async read(sourceModel?: string): Promise<PricingAssociationsPayload> {
    if (sourceModel !== undefined && !isAssociationName(sourceModel)) throw new AssociationError('invalid-source', 400)
    const snapshot = this.capture()
    const context = await readPricingContext(snapshot.dir, this.logger)
    this.verify(snapshot.token)
    return this.payload(context, snapshot.token, sourceModel)
  }

  /** Validate the entire request; clients cannot submit paths, prices or
   * whole files. Idempotency is checked only after the revision guard. */
  async mutate(operation: 'save' | 'delete', value: unknown): Promise<PricingAssociationsPayload> {
    const fields = operation === 'save' ? ['sourceModel', 'targetModelId', 'revision', 'directoryToken'] : ['sourceModel', 'revision', 'directoryToken']
    if (!exactFields(value, fields) || !isAssociationName(value.sourceModel)
      || (operation === 'save' && !isAssociationName(value.targetModelId))
      || typeof value.directoryToken !== 'string' || value.directoryToken === ''
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new AssociationError('invalid-body', 400)
    const input = value as unknown as SavePricingAssociation | DeletePricingAssociation
    const snapshot = this.capture()
    this.verify(input.directoryToken)
    return withPricingDirectoryWrite(snapshot.dir, async () => {
      this.verify(input.directoryToken)
      const context = await readPricingContextLocked(snapshot.dir, this.logger)
      this.verify(input.directoryToken)
      const stored = context.associations
      if (stored.state !== 'ready') throw new AssociationError('association-storage-unavailable', 503)
      if (stored.file.revision !== input.revision) throw new AssociationError('revision-conflict')
      const key = modelKey(input.sourceModel)
      const current = stored.file.associations.find(row => modelKey(row.sourceModel) === key)
      let target: string | undefined
      if (operation === 'save') {
        if (!context.available) throw new AssociationError('pricing-unavailable')
        if (context.resolveAutomatic(input.sourceModel).status === 'matched') throw new AssociationError('source-automatically-priced')
        const requested = (input as SavePricingAssociation).targetModelId
        target = context.models.find(model => modelKey(model.modelId) === modelKey(requested))?.modelId
        if (target === undefined) throw new AssociationError('target-unavailable')
      }
      if ((operation === 'delete' && current === undefined)
        || (target !== undefined && current !== undefined && modelKey(current.targetModelId) === modelKey(target))) {
        return this.payload(context, snapshot.token, input.sourceModel)
      }
      if (stored.file.revision === Number.MAX_SAFE_INTEGER) throw new AssociationError('revision-exhausted')
      const associations = stored.file.associations.filter(row => modelKey(row.sourceModel) !== key)
      if (target !== undefined) associations.push({ sourceModel: current?.sourceModel ?? input.sourceModel, targetModelId: target })
      associations.sort((a, b) => modelKey(a.sourceModel).localeCompare(modelKey(b.sourceModel)))
      await writeAssociations(snapshot.dir, stored, { version: 1, revision: stored.file.revision + 1, associations }, () => this.verify(input.directoryToken))
      const updated = await readPricingContextLocked(snapshot.dir, this.logger)
      this.verify(input.directoryToken)
      return this.payload(updated, snapshot.token, input.sourceModel)
    })
  }
}
