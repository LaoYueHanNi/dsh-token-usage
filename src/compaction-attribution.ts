/**
 * Compaction attribution (shared window): the model behind the rewrite
 * annotation the request pool attaches to plain-request rows. Each session
 * keeps a window of the
 * compaction events that landed since its last PLAIN request — when a plain
 * request row is projected and the window is non-empty, the row carries the
 * window as its attribution and the window resets.
 *
 * Why attribution, not a cache verdict: the host's compaction rewrites the
 * context prefix (tool-result pruning shadows messages, an LLM summary
 * replaces history), so the prefix cache of the FIRST request after the
 * rewrite may miss through no fault of the provider. The miss severity is a
 * function of the earliest rewritten position, so「affected」 never implies
 *「cache lost」 — the annotation explains, `assessRequestCache` stays
 * untouched.
 *
 * Clustering: a prune batch lands as prune events interleaved with the
 * step's straggling `tool/result` appends (verified on real session logs:
 * seq 97–107 = prune / tool/result alternating at one step boundary), so
 * EVERY prune inside one window folds into ONE cluster item (count = event
 * count, tokens = the shadowed sum) no matter what non-compaction events
 * interleave. A summary is its own item and separates the clusters around
 * it (prune → summary → prune reads as two rewrites with the summary's
 * replacement in between). Consuming the window for a plain request ends
 * the cluster by definition.
 *
 * The window is pure in-memory state over the session event stream, so the
 * live recorder and the history rescan drive the SAME implementation — the
 * annotation can never diverge between the two paths.
 *
 * @module token-usage/compaction-attribution
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the declaration-merged `compaction/*` event payloads into
// this program, so `SessionEvent<'compaction/prune'>` below is nameable.
import type {} from '@deepseek-ai/dsh-compaction/types'

/** Which host compaction operation rewrote the prefix. */
export type CompactionSourceKind = 'prune' | 'summary'

/** One attribution entry a request row may carry: the source kind plus the
 * magnitude facts the tooltip needs. */
export interface CompactionAttributionItem {
  /** `prune` — a run of `compaction/prune` events folded into one cluster;
   * `summary` — one `compaction/summary` (its summarize call bills as its
   * own compaction row; this entry only explains the prefix rewrite). */
  kind: CompactionSourceKind
  /** Prune cluster: the number of folded prune events. Summary: always 1. */
  count: number
  /** Shadow tokens: the cluster's summed / the summary's own
   * `shadowedTokenCount` — the heuristic price of the shadowed content,
   * NOT a claim about the exact context-size reduction. */
  shadowedTokenCount: number
}

/** Defensive read of one shadowed figure: a non-finite or negative value
 * reads as 0 (the event count is still a fact; its magnitude is not). */
function shadowTokensOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The per-session attribution window: compaction events since the last plain
 * request. Feed every session event through {@link observe} in stream order;
 * call {@link consumeForRequest} when a plain-request row is projected — a
 * non-empty window is returned (and reset) as that row's attribution.
 */
export class CompactionAttributionWindow {
  private items: CompactionAttributionItem[] = []

  /** Fold one session event into the window. Only `compaction/prune` and
   * `compaction/summary` contribute items; every other event type is
   * cluster-transparent (straggling tool results and step/turn boundaries
   * interleave a prune batch without splitting it — a cluster ends only at
   * a summary or at the window's consumption). */
  observe(event: SessionEvent): void {
    if (event.type === 'compaction/prune') {
      const last = this.items[this.items.length - 1]
      const tokens = shadowTokensOf(event.data.shadowedTokenCount)
      if (last !== undefined && last.kind === 'prune') {
        last.count += 1
        last.shadowedTokenCount += tokens
      } else {
        this.items.push({ kind: 'prune', count: 1, shadowedTokenCount: tokens })
      }
      return
    }
    if (event.type === 'compaction/summary') {
      this.items.push({ kind: 'summary', count: 1, shadowedTokenCount: shadowTokensOf(event.data.shadowedTokenCount) })
    }
  }

  /** Take the window for a plain-request row: the accumulated attribution
   * when any, and the window resets either way (the request consumed it).
   * Only plain request rows consume — a compaction row is the rewrite's own
   * billing row, and a failure row has no cache figures to explain; the
   * window then survives until the next plain request, whose prefix the
   * rewrite still precedes. */
  consumeForRequest(): CompactionAttributionItem[] | undefined {
    if (this.items.length === 0) return undefined
    const out = this.items
    this.items = []
    return out
  }
}
