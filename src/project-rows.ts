/**
 * Project aggregation over root-session rows, shared by the host's full
 * project dimension and the browser's older-host compatibility fallback.
 * The host folds before truncating the session list. A worktree checkout
 * (the dsh-worktree plugin's `<repo>/.dsh/gitworktree/<branch>` layout)
 * belongs to its repository before the directory tail is taken.
 *
 * @module token-usage/project-rows
 */

import type { ProjectUsageRow, SessionUsageRow, UsageTotals } from './wire.ts'

function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/** The last path segment of a directory, on either separator. */
export function dirTailOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/u).filter(part => part !== '')
  return parts[parts.length - 1] ?? cwd
}

/** The dsh-worktree plugin's project-internal layout marker: a checkout
 * at `<repo>/.dsh/gitworktree/<branch>` belongs to `<repo>`. Matches the
 * branch segment (never the bare layout root) and everything under it,
 * on either separator. */
const WORKTREE_LAYOUT = /[/\\]\.dsh[/\\]gitworktree[/\\][^/\\]+/u

/**
 * Map a session cwd onto the repository it belongs to for project
 * aggregation: a `<repo>/.dsh/gitworktree/<branch>` checkout (the
 * dsh-worktree plugin's project layout, deeper subdirectories included)
 * folds onto its repository root, so worktree sessions join the
 * repository's own project row instead of surfacing as a project of
 * their own. Any other path returns unchanged. Pure string work — the
 * host fold and the browser's older-host fallback must share one rule,
 * and neither can probe the disk.
 */
export function belongedCwdOf(cwd: string): string {
  const match = WORKTREE_LAYOUT.exec(cwd)
  return match === null ? cwd : cwd.slice(0, match.index)
}

/** Element-wise totals sum: the counted fields add, the optional ones
 * treat absence as 0 and stay absent only while both sides lack them. */
function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  const sum: UsageTotals = {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
  const compactions = (left.compactions ?? 0) + (right.compactions ?? 0)
  if (compactions > 0 || left.compactions !== undefined || right.compactions !== undefined) {
    sum.compactions = compactions
  }
  const failures = (left.failures ?? 0) + (right.failures ?? 0)
  if (failures > 0 || left.failures !== undefined || right.failures !== undefined) {
    sum.failures = failures
  }
  if (left.failuresByCode !== undefined || right.failuresByCode !== undefined) {
    const byCode: Record<string, number> = {}
    for (const [code, count] of Object.entries(left.failuresByCode ?? {})) byCode[code] = count
    for (const [code, count] of Object.entries(right.failuresByCode ?? {})) {
      byCode[code] = (byCode[code] ?? 0) + count
    }
    sum.failuresByCode = byCode
  }
  for (const key of ['perfLatencyMsSum', 'perfLatencyCount', 'perfStreamTpsSum', 'perfStreamFirstMsSum', 'perfStreamCount'] as const) {
    if (left[key] !== undefined || right[key] !== undefined) sum[key] = (left[key] ?? 0) + (right[key] ?? 0)
  }
  return sum
}

/**
 * Fold session rows into one row per directory tail, token-descending (the
 * dashboard's relative bars take the first row as their 100%). The tail is
 * the bucket key — two different full paths ending in the same segment read
 * as one project here, matching the demo's semantics — and a worktree
 * checkout (`<repo>/.dsh/gitworktree/<branch>`, see {@link belongedCwdOf})
 * folds onto its repository before the tail is taken, so its sessions join
 * the repository's project. Within a bucket the first-seen (belonged) cwd
 * rides along as the representative full path. The input order is preserved
 * inside a bucket (the served rows arrive cost-sorted).
 * @param rows - subtree-folded root sessions; the host supplies the full
 * set, not the truncated session list.
 */
export function projectRowsOf(rows: readonly SessionUsageRow[]): ProjectUsageRow[] {
  const buckets = new Map<string, ProjectUsageRow>()
  for (const row of rows) {
    const owned = row.cwd === undefined ? undefined : belongedCwdOf(row.cwd)
    const name = owned === undefined ? '' : dirTailOf(owned)
    const bucket = buckets.get(name)
    if (bucket === undefined) {
      buckets.set(name, {
        name,
        ...(owned === undefined ? {} : { cwd: owned }),
        sessionCount: 1,
        totals: { ...row.totals },
        cost: row.cost,
      })
      continue
    }
    if (bucket.cwd === undefined && owned !== undefined) bucket.cwd = owned
    bucket.sessionCount += 1
    bucket.totals = addTotals(bucket.totals, row.totals)
    bucket.cost += row.cost
  }
  return [...buckets.values()].sort((left, right) => totalTokens(right.totals) - totalTokens(left.totals))
}
