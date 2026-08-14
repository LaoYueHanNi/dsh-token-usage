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
export const NS = 'token-usage';
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
    'stat.hitRate': '缓存命中率',
    'stat.input': '输入',
    'stat.output': '输出',
    'stat.cacheRead': '缓存读',
    'stat.cacheWrite': '缓存写',
    'byModel.title': '按模型',
    'dataDir': '数据目录：{path}',
    'loadFailed': '统计加载失败：{message}',
    'empty': '暂无数据。可调整筛选条件；模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。',
    'chart.empty': '区间内暂无数据',
    'chart.aria': '每日总 token 曲线',
};
/** English dictionary (same key set). */
export const en = {
    'nav.label': 'Token Usage',
    'filter.quickRange': 'Quick range',
    'filter.custom': 'Custom',
    'filter.from': 'Start date',
    'filter.to': 'End date',
    'filter.separator': 'to',
    'filter.model': 'Model',
    'filter.allModels': 'All models',
    'stat.requests': 'Requests',
    'stat.totalTokens': 'Total tokens',
    'stat.hitRate': 'Cache hit rate',
    'stat.input': 'Input',
    'stat.output': 'Output',
    'stat.cacheRead': 'Cache read',
    'stat.cacheWrite': 'Cache write',
    'byModel.title': 'By model',
    'dataDir': 'Data directory: {path}',
    'loadFailed': 'Failed to load stats: {message}',
    'empty': 'No data yet. Adjust the filters; requests are written automatically after each successful model call, and older history can be backfilled with /token-usage-sync in the command palette.',
    'chart.empty': 'No data in range',
    'chart.aria': 'Daily total token trend',
};
//# sourceMappingURL=locales.js.map