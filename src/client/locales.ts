/**
 * `token-usage` locale namespace dictionaries (browser half). zh is the
 * key-set source of truth; en is checked complete against it — the typed
 * `ctx.locale.register(NS, { zh, en })` call enforces both at compile time
 * and the `t` standard seat narrows its key domain to this union plus the
 * shared common vocabulary.
 *
 * @module token-usage/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'token-usage'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav.label': 'Token 用量',
  'filter.quickRange': '快捷区间',
  'filter.custom': '自定义',
  'filter.from': '开始日期',
  'filter.to': '结束日期',
  'filter.separator': '至',
  'filter.model': '模型',
  'filter.allModels': '全部模型',
  'stat.requests': '请求数',
  'stat.totalTokens': '总 token',
  'stat.hitRate': '命中率',
  'stat.cost': '费用',
  'stat.input': '入',
  'stat.output': '出',
  'stat.cacheRead': '缓',
  'stat.cacheWrite': '写',
  'byModel.title': '按模型',
  'pricing.title': '模型定价',
  'pricing.view': '查看 {model} 定价',
  'pricing.viewShort': '定价',
  'pricing.close': '关闭',
  'pricing.condition': '计费条件',
  'pricing.default': '默认',
  'pricing.regular': '常规（规则期外）',
  'pricing.tier': '上下文 ≥{threshold}',
  'pricing.peak': '峰时',
  'pricing.input': '入',
  'pricing.output': '出',
  'pricing.cacheRead': '缓',
  'pricing.cacheWrite': '写',
  'pricing.perMillion': '/M',
  'pricing.exchangeRateNote': '按 1 USD = {rate} CNY 换算',
  'pricing.unpriced': '未定价',
  'pricing.windowSep': '、',
  'unpriced.warning': '{count} 个模型未定价：{models}（费用按 {zero} 计）',
  'dataDir': '数据目录：{path}',
  'card.title': 'Token 用量',
  'card.description': '设置定价数据源',
  'card.expand': '展开',
  'card.collapse': '折叠',
  'card.unsaved': '未保存',
  'card.readOnly': '设置文档当前为只读，本次无法修改。',
  'card.regionLabel': '定价区域',
  'card.regionDefault': '默认（国内 Gitee）',
  'card.region.domestic': '国内（Gitee）',
  'card.region.overseas': '全球（GitHub）',
  'card.hint': '切换到「全球」后从 GitHub 镜像拉取定价表，费用按美元展示（RMB ÷ 汇率）；保存后立即重新同步，失败沿用旧镜像。',
  'card.overridden': '已覆盖默认值',
  'card.save': '保存',
  'card.saving': '保存中…',
  'card.saveFailed': '保存未生效，请重试。',
  'card.discard': '放弃',
  'loadFailed': '统计加载失败：{message}',
  'empty': '暂无数据。可调整筛选条件；模型请求成功后会自动写入，安装前已发生的历史记录会在首次启动时自动补齐。',
  'chart.empty': '区间内暂无数据',
  'chart.aria': '每日总 token 曲线',
  'chart.ariaHour': '单日分时 token 曲线',
  'chart.pointLabel': '{day} 总量 {tokens}',
} as const

/** English dictionary (same key set). */
export const en: Record<TokenUsageKey, string> = {
  'nav.label': 'Token Usage',
  'filter.quickRange': 'Quick range',
  'filter.custom': 'Custom',
  'filter.from': 'Start date',
  'filter.to': 'End date',
  'filter.separator': 'to',
  'filter.model': 'Model',
  'filter.allModels': 'All models',
  'stat.requests': 'Requests',
  'stat.totalTokens': 'Total',
  'stat.hitRate': 'Hit %',
  'stat.cost': 'Cost',
  'stat.input': 'In',
  'stat.output': 'Out',
  'stat.cacheRead': 'Cache',
  'stat.cacheWrite': 'Write',
  'byModel.title': 'By model',
  'pricing.title': 'Model pricing',
  'pricing.view': 'View rates for {model}',
  'pricing.viewShort': 'Rates',
  'pricing.close': 'Close',
  'pricing.condition': 'Condition',
  'pricing.default': 'Default',
  'pricing.regular': 'Regular (outside rule windows)',
  'pricing.tier': 'context ≥{threshold}',
  'pricing.peak': 'Peak',
  'pricing.input': 'In',
  'pricing.output': 'Out',
  'pricing.cacheRead': 'Cache',
  'pricing.cacheWrite': 'Write',
  'pricing.perMillion': '/M',
  'pricing.exchangeRateNote': 'Converted at 1 USD = {rate} CNY',
  'pricing.unpriced': 'Unpriced',
  'pricing.windowSep': ', ',
  'unpriced.warning': '{count} models unpriced: {models} (cost counts as {zero})',
  'dataDir': 'Data directory: {path}',
  'card.title': 'Token Usage',
  'card.description': 'Pricing data source',
  'card.expand': 'Expand',
  'card.collapse': 'Collapse',
  'card.unsaved': 'Unsaved',
  'card.readOnly': 'The settings document is read-only right now; changes are disabled.',
  'card.regionLabel': 'Pricing region',
  'card.regionDefault': 'Default (Gitee)',
  'card.region.domestic': 'CN (Gitee)',
  'card.region.overseas': 'Global (GitHub)',
  'card.hint': 'Switching to Global pulls the pricing table from the GitHub mirror and shows costs in USD (RMB ÷ rate); saving re-syncs immediately, falling back to the previous mirror on failure.',
  'card.overridden': 'Overriding the default',
  'card.save': 'Save',
  'card.saving': 'Saving…',
  'card.saveFailed': 'The save did not land; try again.',
  'card.discard': 'Discard',
  'loadFailed': 'Failed to load stats: {message}',
  'empty': 'No data yet. Adjust the filters; requests are written automatically after each successful model call, and pre-install history is backfilled automatically on the first startup.',
  'chart.empty': 'No data in range',
  'chart.aria': 'Daily total token trend',
  'chart.ariaHour': 'Single-day hourly token trend',
  'chart.pointLabel': '{day} total {tokens}',
}

/** Union of this namespace's dictionary keys. */
export type TokenUsageKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of this plugin's settings nav label and stats page. */
    'token-usage': TokenUsageKey
  }
}
