/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the filter bar (inclusive day range, model
 * select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
 * total-usage strip, the daily-token trend chart, and the per-model detail
 * table with the hit rate last — all following the active filters. There is
 * no refresh button: entering the page or changing a filter refetches (the
 * route answers no-store); only the error state keeps a retry.
 *
 * @module token-usage/client/TokenUsageSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageSummary } from '../wire.ts'
import { STATS_PATH } from '../wire.ts'
import { shiftedDayKey, totalTokens } from './day.ts'
import { formatHitRate, formatTokens } from './format.ts'
import { TrendChart } from './TrendChart.tsx'
import styles from './TokenUsageSection.module.css'

// Re-exported for tests and sibling consumers; the implementations live in
// the leaf modules (day / format) so the chart can share them without a cycle.
export { totalTokens } from './day.ts'
export { formatTokens, formatHitRate } from './format.ts'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: UsageSummary }

/** The active filter selection; '' means unconstrained. */
interface Filters {
  from: string
  to: string
  model: string
}

/** Fetch the summary for one query string; the caller owns the failure presentation. */
async function fetchSummary(query: string): Promise<UsageSummary> {
  const response = await fetch(STATS_PATH + query)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value = (await response.json()) as UsageSummary
  if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
    throw new Error('unexpected stats response')
  }
  return value
}

/**
 * The query string of one filter selection ('' when unconstrained), or null
 * while the range is mid-edit (`from > to`): editing the two date inputs
 * one at a time passes through inverted ranges, and fetching those would
 * only flash an HTTP 400 — the request waits until the range settles.
 */
function filterQuery(filters: Filters): string | null {
  if (filters.from !== '' && filters.to !== '' && filters.from > filters.to) return null
  const params = new URLSearchParams()
  if (filters.from !== '') params.set('from', filters.from)
  if (filters.to !== '') params.set('to', filters.to)
  if (filters.model !== '') params.set('model', filters.model)
  return Array.from(params).length > 0 ? `?${params.toString()}` : ''
}

/** Quick-range day span in days (1 = today only, inclusive on both ends). */
const QUICK_DAYS = [1, 7, 30] as const

/** The day keys of one quick range: today minus (days - 1) through today. */
function quickRange(days: number): { from: string; to: string } {
  return { from: shiftedDayKey(-(days - 1)), to: shiftedDayKey(0) }
}

/** Whether the filters exactly hold one quick range. */
function isQuickActive(days: number, filters: Filters): boolean {
  const range = quickRange(days)
  return filters.from === range.from && filters.to === range.to
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

/** The filter bar: date range, model select, quick range buttons. */
function FilterBar({ filters, models, onChange }: {
  filters: Filters
  models: readonly string[]
  onChange: (next: Filters) => void
}): ReactNode {
  return (
    <div className={styles['filters']}>
      <input
        type="date"
        aria-label="开始日期"
        className={styles['control']}
        value={filters.from}
        onChange={event => onChange({ ...filters, from: event.target.value })}
      />
      <span className={styles['rangeSeparator']}>至</span>
      <input
        type="date"
        aria-label="结束日期"
        className={styles['control']}
        value={filters.to}
        onChange={event => onChange({ ...filters, to: event.target.value })}
      />
      <select
        aria-label="模型"
        className={styles['control']}
        value={filters.model}
        onChange={event => onChange({ ...filters, model: event.target.value })}
      >
        <option value="">全部模型</option>
        {models.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
      <div className={styles['quickButtons']}>
        {QUICK_DAYS.map(days => (
          <button
            key={days}
            type="button"
            className={styles['button']}
            aria-pressed={isQuickActive(days, filters)}
            onClick={() => onChange({ ...filters, ...quickRange(days) })}
          >
            {`${String(days)}d`}
          </button>
        ))}
      </div>
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
  // Entering the page starts on today's window (the 1d quick range).
  const [filters, setFilters] = useState<Filters>(() => ({ model: '', ...quickRange(1) }))
  const [models, setModels] = useState<string[]>([])
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setAttempt(previous => previous + 1) }, [])

  useEffect(() => {
    const query = filterQuery(filters)
    // A mid-edit inverted range keeps the current data until it settles.
    if (query === null) return
    let cancelled = false
    setState({ status: 'loading' })
    void fetchSummary(query)
      .then((summary) => {
        if (cancelled) return
        setState({ status: 'ready', summary })
        // While every model is shown, keep the option list from collapsing
        // to the filtered selection.
        if (filters.model === '') setModels(summary.byModel.map(row => row.model))
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => { cancelled = true }
  }, [filters, attempt])

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
          <button type="button" className={styles['button']} onClick={retry}>重试</button>
        </div>
        <p className={styles['error']}>统计加载失败：{state.message}</p>
      </div>
    )
  }

  const { total } = state.summary
  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>Token 用量</h2>
      <p className={styles['muted']}>数据目录：{state.summary.dataDir}</p>
      <FilterBar filters={filters} models={models} onChange={setFilters} />
      {total.requests === 0
        ? (
          // One hint covers both an empty log and an empty filtered window:
          // the page opens on today (1d), so the two are indistinguishable
          // from the filtered response alone.
          <p className={styles['empty']}>
            暂无数据。可调整筛选条件；模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。
          </p>
        )
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
            <TrendChart
              rows={state.summary.byDay}
              {...filters.from !== '' ? { from: filters.from } : {}}
              {...filters.to !== '' ? { to: filters.to } : {}}
            />
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
                        <th>输入</th>
                        <th>输出</th>
                        <th>缓存读</th>
                        <th>缓存写</th>
                        <th>命中率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.summary.byModel.map(row => (
                        <tr key={row.model}>
                          <td>{row.model}</td>
                          <td>{row.totals.requests.toLocaleString()}</td>
                          <td>{formatTokens(totalTokens(row.totals))}</td>
                          <td>{formatTokens(row.totals.inputTokens)}</td>
                          <td>{formatTokens(row.totals.outputTokens)}</td>
                          <td>{formatTokens(row.totals.cacheReadTokens)}</td>
                          <td>{formatTokens(row.totals.cacheWriteTokens)}</td>
                          <td>{formatHitRate(row.totals)}</td>
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
