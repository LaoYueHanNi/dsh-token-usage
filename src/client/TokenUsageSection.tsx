/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the total-usage strip — requests / total tokens
 * / cache hit rate on one row, the four token buckets on the next — followed
 * by a per-model detail table (one row per model). Token counts are
 * abbreviated (K below 1M, M below 1 亿, B from 1 亿 with B = 10 亿); the page
 * owns no store because nothing outside it reads the summary, and a manual
 * refresh re-fetches after new requests land.
 *
 * @module token-usage/client/TokenUsageSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageSummary, UsageTotals } from '../wire.ts'
import { STATS_PATH } from '../wire.ts'
import styles from './TokenUsageSection.module.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: UsageSummary }

/** Fetch the summary; the caller owns the failure presentation. */
async function fetchSummary(): Promise<UsageSummary> {
  const response = await fetch(STATS_PATH)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value = (await response.json()) as UsageSummary
  if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
    throw new Error('unexpected stats response')
  }
  return value
}

/**
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 1 亿
 * (1e8), `xxB` from 1 亿 up with B = 10 亿 (1e9) — 1 亿 is `0.1B`, 3 亿 is
 * `0.3B`, 10 亿 is `1B`, 30 亿 is `3B`. One decimal while the scaled value is
 * below 10, integer otherwise — `950K`, `1.5M`, `50M`, `0.5B`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return scale(count / 1_000) + 'K'
  if (count < 100_000_000) return scale(count / 1_000_000) + 'M'
  return scale(count / 1_000_000_000) + 'B'
}

/** One decimal below 10, integer otherwise, trailing `.0` stripped. */
function scale(value: number): string {
  if (value >= 10) return String(Math.round(value))
  const oneDecimal = value.toFixed(1)
  return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal
}

/** Always one decimal (stripped when `.0`), unlike {@link scale}: percentages keep their precision. */
function percent(value: number): string {
  const oneDecimal = value.toFixed(1)
  return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal
}

/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
export function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/**
 * Cache hit rate as display text: cache reads over served input
 * (missed input + cache reads). `—` when nothing was served.
 * @param totals - the aggregated totals.
 * @returns e.g. `87.5%`, or `—` for an empty denominator.
 */
export function formatHitRate(totals: UsageTotals): string {
  const served = totals.inputTokens + totals.cacheReadTokens
  if (served === 0) return '—'
  return `${percent(totals.cacheReadTokens / served * 100)}%`
}

/** One card in a metric row. */
function StatCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={styles['card']}>
      <span className={styles['cardLabel']}>{label}</span>
      <span className={styles['cardValue']}>{value}</span>
    </div>
  )
}

/**
 * Render the Token 用量 section content column.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel).
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => { setAttempt(previous => previous + 1) }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void fetchSummary()
      .then((summary) => { if (!cancelled) setState({ status: 'ready', summary }) })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => { cancelled = true }
  }, [attempt])

  if (state.status === 'loading') {
    return (
      <div className={styles['section']}>
        <h2 className={styles['title']}>Token 用量</h2>
        <p className={styles['muted']}>加载中…</p>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className={styles['section']}>
        <div className={styles['head']}>
          <h2 className={styles['title']}>Token 用量</h2>
          <button type="button" className={styles['button']} onClick={refresh}>重试</button>
        </div>
        <p className={styles['error']}>统计加载失败：{state.message}</p>
      </div>
    )
  }

  const { total } = state.summary
  return (
    <div className={styles['section']}>
      <div className={styles['head']}>
        <h2 className={styles['title']}>Token 用量</h2>
        <button type="button" className={styles['button']} onClick={refresh}>刷新</button>
      </div>
      <p className={styles['muted']}>数据目录：{state.summary.dataDir}</p>
      {total.requests === 0
        ? <p className={styles['empty']}>暂无记录。模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。</p>
        : (
          <>
            <div className={styles['cards']}>
              <StatCard label="请求数" value={total.requests.toLocaleString()} />
              <StatCard label="总 token" value={formatTokens(totalTokens(total))} />
              <StatCard label="缓存命中率" value={formatHitRate(total)} />
            </div>
            <div className={styles['cards']}>
              <StatCard label="输入" value={formatTokens(total.inputTokens)} />
              <StatCard label="输出" value={formatTokens(total.outputTokens)} />
              <StatCard label="缓存读" value={formatTokens(total.cacheReadTokens)} />
              <StatCard label="缓存写" value={formatTokens(total.cacheWriteTokens)} />
            </div>
            {state.summary.byModel.length > 0
              ? (
                <>
                  <h3 className={styles['subtitle']}>按模型</h3>
                  <table className={styles['table']}>
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th>请求数</th>
                        <th>总 token</th>
                        <th>命中率</th>
                        <th>输入</th>
                        <th>输出</th>
                        <th>缓存读</th>
                        <th>缓存写</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.summary.byModel.map(row => (
                        <tr key={row.model}>
                          <td>{row.model}</td>
                          <td>{row.totals.requests.toLocaleString()}</td>
                          <td>{formatTokens(totalTokens(row.totals))}</td>
                          <td>{formatHitRate(row.totals)}</td>
                          <td>{formatTokens(row.totals.inputTokens)}</td>
                          <td>{formatTokens(row.totals.outputTokens)}</td>
                          <td>{formatTokens(row.totals.cacheReadTokens)}</td>
                          <td>{formatTokens(row.totals.cacheWriteTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )
              : null}
          </>
        )}
    </div>
  )
}
