/**
 * Process-memory cache of parsed usage day files. Frozen (pre-today) files
 * stay resident after the first read; today's file is re-read when its size
 * or mtime changes. Concurrent readers of one directory share one in-flight
 * load (singleflight), so the header chip, the usage tab, and a settings
 * refresh cannot pile overlapping full-directory parses onto the event loop.
 *
 * @module token-usage/record-cache
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRecord } from './usage-record.ts'
import type { UsageRecord } from './usage-record.ts'

const DAY_FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/u

/** The date part of a day-file name, or null for a foreign name. */
export function fileDay(name: string): string | null {
  return DAY_FILE.exec(name)?.[1] ?? null
}

/** Local date key of a clock reading, matching the day-file naming convention. */
function dayKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Cached parse of one day file, keyed by the on-disk stamp that produced it. */
interface FileEntry {
  records: UsageRecord[]
  size: number
  mtimeMs: number
}

interface DirCache {
  files: Map<string, FileEntry>
  inflight: Promise<UsageRecord[]> | undefined
}

const dirs = new Map<string, DirCache>()

function stateOf(dir: string): DirCache {
  const existing = dirs.get(dir)
  if (existing !== undefined) return existing
  const created: DirCache = { files: new Map(), inflight: undefined }
  dirs.set(dir, created)
  return created
}

/**
 * Drop cached parses. A missing `dir` clears every directory (test seam);
 * a path drops that directory only (data-directory relocation).
 */
export function clearRecordCache(dir?: string): void {
  if (dir === undefined) dirs.clear()
  else dirs.delete(dir)
}

/**
 * Read one day file into records. Malformed lines are skipped silently —
 * the stats read runs on every page refresh and must not spam the console
 * over one bad row. An unreadable file logs once and reads as empty, so a
 * corrupt log never blocks stats.
 * @param dir - the plugin's data directory.
 * @param name - the day-file name.
 */
export async function readDayFile(dir: string, name: string): Promise<UsageRecord[]> {
  const text = await readFile(join(dir, name), 'utf8').catch((error: unknown) => {
    console.error(`[token-usage] cannot read ${name}:`, error)
    return ''
  })
  const records: UsageRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const record = parseRecord(line)
    if (record !== null) records.push(record)
  }
  return records
}

/** List the data directory's day-file names in ascending date order ([] when absent). */
export async function listDayFiles(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter(name => fileDay(name) !== null).sort()
}

async function fileStamp(dir: string, name: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(join(dir, name))
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

async function loadDir(dir: string, cache: DirCache, now: () => Date): Promise<UsageRecord[]> {
  const today = dayKey(now().getTime())
  const names = await listDayFiles(dir)
  const live = new Set(names)
  for (const name of cache.files.keys()) {
    if (!live.has(name)) cache.files.delete(name)
  }
  const out: UsageRecord[] = []
  for (const name of names) {
    const day = fileDay(name)!
    const hot = day >= today
    const cached = cache.files.get(name)
    // Frozen files are append-only history: once parsed they never change.
    if (!hot && cached !== undefined) {
      out.push(...cached.records)
      continue
    }
    const stamp = await fileStamp(dir, name)
    if (stamp === null) {
      cache.files.delete(name)
      continue
    }
    if (cached !== undefined && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) {
      out.push(...cached.records)
      continue
    }
    const records = await readDayFile(dir, name)
    cache.files.set(name, { records, size: stamp.size, mtimeMs: stamp.mtimeMs })
    out.push(...records)
  }
  return out
}

/**
 * Read every day file into records, serving frozen files from memory after
 * the first parse. An absent data directory yields an empty list.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 */
export async function readCachedRecords(dir: string, now: () => Date = () => new Date()): Promise<UsageRecord[]> {
  const cache = stateOf(dir)
  if (cache.inflight !== undefined) return cache.inflight
  const pending = loadDir(dir, cache, now).finally(() => {
    if (cache.inflight === pending) cache.inflight = undefined
  })
  cache.inflight = pending
  return pending
}

/** Populate the cache for one directory so the first stats poll is a memory hit. */
export async function warmRecordCache(dir: string, now?: () => Date): Promise<void> {
  await readCachedRecords(dir, now)
}
