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
    readonly 'stat.hitRate': "命中率";
    readonly 'stat.cost': "费用";
    readonly 'stat.input': "入";
    readonly 'stat.output': "出";
    readonly 'stat.cacheRead': "缓";
    readonly 'stat.cacheWrite': "写";
    readonly 'byModel.title': "按模型";
    readonly 'pricing.title': "模型定价";
    readonly 'pricing.view': "查看 {model} 定价";
    readonly 'pricing.viewShort': "定价";
    readonly 'pricing.close': "关闭";
    readonly 'pricing.condition': "计费条件";
    readonly 'pricing.default': "默认";
    readonly 'pricing.regular': "常规（规则期外）";
    readonly 'pricing.tier': "上下文 ≥{threshold}";
    readonly 'pricing.peak': "峰时";
    readonly 'pricing.input': "入";
    readonly 'pricing.output': "出";
    readonly 'pricing.cacheRead': "缓";
    readonly 'pricing.cacheWrite': "写";
    readonly 'pricing.perMillion': "/M";
    readonly 'pricing.exchangeRateNote': "按 1 USD = {rate} CNY 换算";
    readonly 'pricing.unpriced': "未定价";
    readonly 'pricing.windowSep': "、";
    readonly 'unpriced.warning': "{count} 个模型未定价：{models}（费用按 {zero} 计）";
    readonly dataDir: "数据目录：{path}";
    readonly 'card.title': "Token 用量";
    readonly 'card.description': "设置定价数据源";
    readonly 'card.expand': "展开";
    readonly 'card.collapse': "折叠";
    readonly 'card.unsaved': "未保存";
    readonly 'card.readOnly': "设置文档当前为只读，本次无法修改。";
    readonly 'card.regionLabel': "定价区域";
    readonly 'card.regionDefault': "默认（国内 Gitee）";
    readonly 'card.region.domestic': "国内（Gitee）";
    readonly 'card.region.overseas': "全球（GitHub）";
    readonly 'card.hint': "切换到「全球」后从 GitHub 镜像拉取定价表，费用按美元展示（RMB ÷ 汇率）；保存后立即重新同步，失败沿用旧镜像。";
    readonly 'card.overridden': "已覆盖默认值";
    readonly 'card.save': "保存";
    readonly 'card.saving': "保存中…";
    readonly 'card.saveFailed': "保存未生效，请重试。";
    readonly 'card.discard': "放弃";
    readonly loadFailed: "统计加载失败：{message}";
    readonly empty: "暂无数据。可调整筛选条件；模型请求成功后会自动写入，安装前已发生的历史记录会在首次启动时自动补齐。";
    readonly 'chart.empty': "区间内暂无数据";
    readonly 'chart.aria': "每日总 token 曲线";
    readonly 'chart.ariaHour': "单日分时 token 曲线";
    readonly 'chart.pointLabel': "{day} 总量 {tokens}";
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