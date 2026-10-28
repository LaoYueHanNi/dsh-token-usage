/**
 * Provider display-name registry of the token-usage plugin: `providers.json`
 * in the data directory, mapping a route key to the latest human-readable
 * name reported by the host provider directory.
 *
 * Usage rows store only the route key. A display name changes when the
 * user renames a route, and the latest name wins, so the name is not
 * frozen onto each JSONL row. This file is not a projection of the
 * session logs: a lost file is refilled from the current directory, and
 * a route that has since been removed keeps the last name seen here.
 * The file moves with the data directory.
 *
 * @module token-usage/provider-names
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleLogger, type LoggerLike } from './log.ts'

export const PROVIDERS_FILE = 'providers.json'
const TMP_FILE = 'providers.json.tmp'

/** Route key → latest display name. Absent keys are not stored as empty strings. */
export type ProviderNameIndex = Record<string, string>

/**
 * Label for a route key. A missing or empty registry entry falls back to
 * the key itself, so a route the directory no longer names still displays.
 */
export function providerLabel(id: string, names: Readonly<ProviderNameIndex>): string {
  const name = names[id]
  return name !== undefined && name !== '' ? name : id
}

function coerceIndex(value: unknown): ProviderNameIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: ProviderNameIndex = {}
  for (const [id, name] of Object.entries(value)) {
    if (id === '' || typeof name !== 'string' || name === '') continue
    out[id] = name
  }
  return out
}

/**
 * Read/write access to one data directory's provider-name registry.
 * Writes serialize on one promise chain and persist atomically. A missing
 * or malformed file reads as empty; entries already on disk are never
 * deleted by an upsert.
 */
export class ProviderNameStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly logger: LoggerLike = consoleLogger,
  ) {}

  /** Read the registry. Corruption degrades to the entries that survived. */
  async read(): Promise<ProviderNameIndex> {
    let text: string
    try {
      text = await readFile(join(this.dir, PROVIDERS_FILE), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      this.logger.error('[token-usage] cannot read providers.json:', error)
      return {}
    }
    try {
      return coerceIndex(JSON.parse(text))
    } catch {
      this.logger.error('[token-usage] providers.json is not valid JSON; treating as absent')
      return {}
    }
  }

  /**
   * Merge route keys into the registry. A new name for an existing id
   * overwrites; ids absent from `patch` stay. Empty ids and empty names
   * are ignored. A patch that changes nothing does not rewrite the file.
   */
  upsert(patch: Readonly<ProviderNameIndex>): Promise<void> {
    const incoming: ProviderNameIndex = {}
    for (const [id, name] of Object.entries(patch)) {
      if (id === '' || name === '') continue
      incoming[id] = name
    }
    if (Object.keys(incoming).length === 0) return Promise.resolve()
    const task = this.queue.then(async () => {
      const index = { ...await this.read() }
      let changed = false
      for (const [id, name] of Object.entries(incoming)) {
        if (index[id] === name) continue
        index[id] = name
        changed = true
      }
      if (!changed) return
      await this.write(index)
    })
    this.queue = task.catch(() => {})
    return task
  }

  /** Settle every queued write (the migration's quiescence point). */
  flush(): Promise<void> {
    return this.queue
  }

  private async write(index: ProviderNameIndex): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, PROVIDERS_FILE)
    const tmp = join(this.dir, TMP_FILE)
    await writeFile(tmp, JSON.stringify(index), 'utf8')
    await rename(tmp, target)
  }
}
