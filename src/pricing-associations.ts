/** Durable name references; prices and usage records never live in this file. */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { modelKey } from './model-resolution.ts'
import type { PricingAssociation, AssociationStorageError } from './wire.ts'

export const ASSOCIATIONS_FILE = 'pricing-associations.json'
const TMP_FILE = `${ASSOCIATIONS_FILE}.tmp`

export interface PricingAssociationsFile {
  version: 1
  revision: number
  associations: PricingAssociation[]
}

export type AssociationSnapshot =
  | { state: 'ready'; file: PricingAssociationsFile; source: string | null }
  | { state: 'unavailable'; error: AssociationStorageError; source: string | null }

export class AssociationError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) {
    super(code)
  }
}

/** Compare complete names without trimming or dropping namespace components. */
export function isAssociationName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
}

export function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field))
}

export function coerceAssociations(value: unknown): PricingAssociationsFile | null {
  if (!exactFields(value, ['version', 'revision', 'associations']) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.associations)) return null
  const keys = new Set<string>()
  const associations: PricingAssociation[] = []
  for (const row of value.associations) {
    if (!exactFields(row, ['sourceModel', 'targetModelId'])
      || !isAssociationName(row.sourceModel) || !isAssociationName(row.targetModelId)) return null
    const key = modelKey(row.sourceModel)
    if (keys.has(key)) return null
    keys.add(key)
    associations.push({ sourceModel: row.sourceModel, targetModelId: row.targetModelId })
  }
  return { version: 1, revision: value.revision as number, associations }
}

/** Missing is empty; malformed or unreadable durable choices are never erased. */
export async function readAssociations(dir: string): Promise<AssociationSnapshot> {
  let source: string
  try { source = await readFile(join(dir, ASSOCIATIONS_FILE), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'ready', source: null, file: { version: 1, revision: 0, associations: [] } }
    }
    return { state: 'unavailable', source: null, error: 'unreadable' }
  }
  let value: unknown
  try { value = JSON.parse(source) } catch { return { state: 'unavailable', source, error: 'invalid-json' } }
  const file = coerceAssociations(value)
  return file === null ? { state: 'unavailable', source, error: 'invalid-file' } : { state: 'ready', source, file }
}

interface DirectoryQueue {
  tail: Promise<unknown>
  paused: boolean
  epoch: number
}
const queues = new Map<string, DirectoryQueue>()

export function pricingDirectoryKey(dir: string): string {
  const absolute = resolve(dir)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function queueOf(dir: string): DirectoryQueue {
  const key = pricingDirectoryKey(dir)
  let state = queues.get(key)
  if (state === undefined) { state = { tail: Promise.resolve(), paused: false, epoch: 0 }; queues.set(key, state) }
  return state
}

/** Snapshot reads and feed/association commits share one process-local queue. */
export function withPricingDirectoryRead<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const state = queueOf(dir)
  const task = state.tail.catch(() => undefined).then(run)
  state.tail = task.catch(() => undefined)
  return task
}

export function withPricingDirectoryWrite<T>(dir: string, run: () => Promise<T>): Promise<T> {
  if (queueOf(dir).paused) return Promise.reject(new AssociationError('migration-in-progress'))
  return withPricingDirectoryRead(dir, run)
}

export function associationWritesPaused(dir: string): boolean { return queueOf(dir).paused }
export function pricingDirectoryEpoch(dir: string): number { return queueOf(dir).epoch }

/** Block new commits to both directories, drain already accepted writes,
 * and keep them paused through copying, switching and source cleanup. */
export async function withPricingDirectoryMigration<T>(oldDir: string, newDir: string, run: () => Promise<T>): Promise<T> {
  const states = [...new Set([queueOf(oldDir), queueOf(newDir)])]
  if (states.some(state => state.paused)) throw new AssociationError('migration-in-progress')
  for (const state of states) { state.paused = true; state.epoch += 1 }
  try {
    await Promise.all(states.map(state => state.tail))
    return await run()
  } finally { for (const state of states) state.paused = false }
}

/** Caller holds the directory queue. Verify both the directory epoch and
 * original bytes immediately before replacing durable user choices. */
export async function writeAssociations(
  dir: string, expected: AssociationSnapshot & { state: 'ready' }, file: PricingAssociationsFile,
  verifyDirectory: () => void,
): Promise<void> {
  const path = join(dir, ASSOCIATIONS_FILE), tmp = join(dir, TMP_FILE)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify(file) + '\n', 'utf8')
    const source = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    verifyDirectory()
    if (source !== expected.source) throw new AssociationError('revision-conflict')
    await rename(tmp, path)
  } finally { await unlink(tmp).catch(() => undefined) }
}
