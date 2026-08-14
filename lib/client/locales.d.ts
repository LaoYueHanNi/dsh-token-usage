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
export declare const NS = "token-usage";
/** Simplified Chinese dictionary (the key-set source of truth). */
export declare const zh: {
    readonly 'nav.label': "Token 用量";
    readonly 'filter.quickRange': "快捷区间";
    readonly 'filter.custom': "自定义";
    readonly 'filter.from': "开始日期";
    readonly 'filter.to': "结束日期";
    readonly 'filter.separator': "至";
    readonly 'filter.model': "模型";
    readonly 'filter.allModels': "全部模型";
    readonly 'stat.requests': "请求数";
    readonly 'stat.totalTokens': "总 token";
    readonly 'stat.hitRate': "缓存命中率";
    readonly 'stat.input': "输入";
    readonly 'stat.output': "输出";
    readonly 'stat.cacheRead': "缓存读";
    readonly 'stat.cacheWrite': "缓存写";
    readonly 'byModel.title': "按模型";
    readonly dataDir: "数据目录：{path}";
    readonly loadFailed: "统计加载失败：{message}";
    readonly empty: "暂无数据。可调整筛选条件；模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。";
    readonly 'chart.empty': "区间内暂无数据";
    readonly 'chart.aria': "每日总 token 曲线";
};
/** English dictionary (same key set). */
export declare const en: Record<TokenUsageKey, string>;
/** Union of this namespace's dictionary keys. */
export type TokenUsageKey = keyof typeof zh;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Copy of this plugin's settings nav label and stats page. */
        'token-usage': TokenUsageKey;
    }
}
//# sourceMappingURL=locales.d.ts.map