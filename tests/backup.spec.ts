import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BACKUP_SNAPSHOT_DIR,
  BACKUPS_DIR,
  MAX_BACKUP_COUNT,
  backupDayFiles,
  isBackupSnapshotName,
} from '../src/backup.ts'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'token-usage-backup-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

describe('backupDayFiles', () => {
  it('returns null without creating .backups when given no existing files', async () => {
    const dir = await tempDir()
    expect(await backupDayFiles(dir, [], 'reconcile')).toBeNull()
    expect(await backupDayFiles(dir, ['usage-2026-01-15.jsonl'], 'refile')).toBeNull()
    expect(existsSync(join(dir, BACKUPS_DIR))).toBe(false)
  })

  it('copies only existing deduplicated files verbatim into a timestamped snapshot directory', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), '{"requestId":"a"}\n', 'utf8')
    const snapshotDir = await backupDayFiles(
      dir,
      ['usage-2026-01-15.jsonl', 'usage-2026-01-15.jsonl', 'usage-2026-01-16.jsonl'],
      'reconcile',
    )
    expect(snapshotDir).not.toBeNull()
    const entries = await readdir(join(dir, BACKUPS_DIR))
    expect(entries).toHaveLength(1)
    expect(BACKUP_SNAPSHOT_DIR.test(entries[0]!)).toBe(true)
    expect(isBackupSnapshotName(entries[0]!)).toBe(true)
    expect(entries[0]!.endsWith('-reconcile')).toBe(true)
    expect(await readFile(join(snapshotDir!, 'usage-2026-01-15.jsonl'), 'utf8')).toBe('{"requestId":"a"}\n')
    expect(existsSync(join(snapshotDir!, 'usage-2026-01-16.jsonl'))).toBe(false)
  })

  it('rotates snapshots to retain only the newest five and preserves foreign entries', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), 'row-0\n', 'utf8')
    const backupsRoot = join(dir, BACKUPS_DIR)
    await mkdir(backupsRoot, { recursive: true })
    await writeFile(join(backupsRoot, 'user-note.txt'), 'keep me', 'utf8')
    await mkdir(join(backupsRoot, 'manual-backup'))

    const createdNames: string[] = []
    for (let i = 0; i < MAX_BACKUP_COUNT + 3; i += 1) {
      await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `row-${String(i)}\n`, 'utf8')
      const path = await backupDayFiles(dir, ['usage-2026-01-15.jsonl'], 'backfill-timing')
      expect(path).not.toBeNull()
      createdNames.push(path!.split(/[/\\]/u).pop()!)
    }

    const after = (await readdir(backupsRoot)).sort()
    const retainedSnapshots = after.filter(isBackupSnapshotName)
    expect(retainedSnapshots).toEqual(createdNames.slice(-MAX_BACKUP_COUNT))
    expect(after).toContain('user-note.txt')
    expect(after).toContain('manual-backup')
    const latestDir = join(backupsRoot, retainedSnapshots.at(-1)!)
    expect(await readFile(join(latestDir, 'usage-2026-01-15.jsonl'), 'utf8'))
      .toBe(`row-${String(MAX_BACKUP_COUNT + 2)}\n`)
  })

  it('removes partial snapshot and rejects when copying fails', async () => {
    const dir = await tempDir()
    // Make a directory with the day-file name so access() succeeds but copyFile() fails.
    await mkdir(join(dir, 'usage-2026-01-15.jsonl'))
    await expect(backupDayFiles(dir, ['usage-2026-01-15.jsonl'], 'complete-fields')).rejects.toThrow()
    const entries = await readdir(join(dir, BACKUPS_DIR))
    expect(entries).toEqual([])
  })
})
