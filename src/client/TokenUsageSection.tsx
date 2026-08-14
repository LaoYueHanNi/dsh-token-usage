/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders totals, per-day and per-model tables, and the
 * recent request list. Data arrives through plain fetch into component-local
 * state — the page owns no store because nothing outside it reads the
 * summary; a manual refresh re-fetches after new requests land.
 *
 * @module token-usage/client/TokenUsageSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageRecord, UsageSummary, UsageTotals } from '../wire.ts'
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

/** One card in the totals strip. */
function StatCard({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className={styles['card']}>
      <span className={styles['cardLabel']}>{label}</span>
      <span className={styles['cardValue']}>{value.toLocaleString()}</span>
    </div>
  )
}

/** One totals row of the per-day/per-model tables. */
function TotalsRow({ name, totals }: { name: string; totals: UsageTotals }): ReactNode {
  return (
    <tr>
      <td>{name}</td>
      <td>{totals.requests.toLocaleString()}</td>
      <td>{totals.inputTokens.toLocaleString()}</td>
      <td>{totals.outputTokens.toLocaleString()}</td>
      <td>{totals.cacheReadTokens.toLocaleString()}</td>
      <td>{totals.cacheWriteTokens.toLocaleString()}</td>
    </tr>
  )
}

/** Human summary of one record's token buckets. */
function usageText(record: UsageRecord): string {
  const usage = record.usage
  if (usage === undefined) return '无用量数据'
  const parts = [`输入 ${usage.inputTokens.toLocaleString()}`, `输出 ${usage.outputTokens.toLocaleString()}`]
  if (usage.cacheReadTokens !== undefined) parts.push(`缓存读 ${usage.cacheReadTokens.toLocaleString()}`)
  if (usage.cacheWriteTokens !== undefined) parts.push(`缓存写 ${usage.cacheWriteTokens.toLocaleString()}`)
  return parts.join(' · ')
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

  const { summary } = state
  return (
    <div className={styles['section']}>
      <div className={styles['head']}>
        <h2 className={styles['title']}>Token 用量</h2>
        <button type="button" className={styles['button']} onClick={refresh}>刷新</button>
      </div>
      <p className={styles['muted']}>数据目录：{summary.dataDir}</p>
      {summary.total.requests === 0
        ? <p className={styles['empty']}>暂无记录。模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。</p>
        : (
          <>
            <div className={styles['cards']}>
              <StatCard label="请求数" value={summary.total.requests} />
              <StatCard label="输入 tokens" value={summary.total.inputTokens} />
              <StatCard label="输出 tokens" value={summary.total.outputTokens} />
              <StatCard label="缓存读 tokens" value={summary.total.cacheReadTokens} />
              <StatCard label="缓存写 tokens" value={summary.total.cacheWriteTokens} />
            </div>
            <h3 className={styles['subtitle']}>按日</h3>
            <table className={styles['table']}>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>请求</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                </tr>
              </thead>
              <tbody>
                {summary.byDay.map(row => <TotalsRow key={row.day} name={row.day} totals={row.totals} />)}
              </tbody>
            </table>
            <h3 className={styles['subtitle']}>按模型</h3>
            <table className={styles['table']}>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>请求</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                </tr>
              </thead>
              <tbody>
                {summary.byModel.map(row => <TotalsRow key={row.model} name={row.model} totals={row.totals} />)}
              </tbody>
            </table>
            <h3 className={styles['subtitle']}>最近请求</h3>
            <ul className={styles['recent']}>
              {summary.recent.map(record => (
                <li key={record.requestId} className={styles['recentRow']}>
                  <span className={styles['recentTime']}>{new Date(record.time).toLocaleString()}</span>
                  <span className={styles['recentModel']}>{record.model}</span>
                  <span className={`${styles['recentUsage']} ${styles['muted']}`}>{usageText(record)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
    </div>
  )
}
