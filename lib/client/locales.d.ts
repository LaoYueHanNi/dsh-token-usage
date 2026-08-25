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
    readonly 'card.description': "数据目录与定价数据源";
    readonly 'card.expand': "展开";
    readonly 'card.collapse': "折叠";
    readonly 'card.unsaved': "未保存";
    readonly 'card.readOnly': "设置文档当前为只读，本次无法修改。";
    readonly 'card.pathLabel': "数据目录";
    readonly 'card.pathHint': "留空使用默认位置（~/.dsh/token-usage）。";
    readonly 'card.browse': "浏览…";
    readonly 'card.picking': "选择中…";
    readonly 'card.migratingCopy': "正在复制数据 {done}/{total} 个文件…";
    readonly 'card.migratingClean': "正在清理旧目录 {done}/{total} 个文件…";
    readonly 'card.regionLabel': "定价区域";
    readonly 'card.regionDefault': "默认（国内 Gitee）";
    readonly 'card.region.domestic': "国内（Gitee）";
    readonly 'card.region.overseas': "全球（GitHub）";
    readonly 'card.hint': "切换到「全球」后从 GitHub 镜像拉取定价表，费用按美元展示（RMB ÷ 汇率）；保存后立即重新同步，失败沿用旧镜像。";
    readonly 'card.overridden': "已覆盖默认值";
    readonly 'card.save': "保存";
    readonly 'card.saving': "保存中…";
    readonly 'card.saveFailed': "保存未生效，请重试。";
    readonly 'card.saveBlockedSessions': "有会话正在进行对话，无法保存目录修改；请等待对话结束（当前 {count} 个）。";
    readonly 'card.discard': "放弃";
    readonly 'card.fullSync.title': "全量扫描同步";
    readonly 'card.fullSync.hint': "手动扫一遍所有 session 日志，把可能漏掉的历史请求补进来（已记录的会跳过）。";
    readonly 'card.fullSync.button': "开始扫描";
    readonly 'card.fullSync.running': "扫描中…";
    readonly 'card.fullSync.progress': "已处理 {processed}/{total} 个 session，新增 {added} 条，跳过 {skipped} 条";
    readonly 'card.fullSync.done': "扫描完成：新增 {added} 条，跳过 {skipped} 条";
    readonly 'card.fullSync.failed': "扫描失败：{error}";
    readonly loadFailed: "统计加载失败：{message}";
    readonly empty: "暂无数据。可调整筛选条件；模型请求成功后会自动写入，安装前已发生的历史记录会在首次启动时自动补齐。";
    readonly 'chart.empty': "区间内暂无数据";
    readonly 'chart.aria': "每日总 token 曲线";
    readonly 'chart.ariaHour': "单日分时 token 曲线";
    readonly 'chart.ariaRequests': "按时间分段的 token 曲线";
    readonly 'chart.pointLabel': "{day} 总量 {tokens}";
    readonly 'chart.bucket': "{window} · {count} 请求 · {tokens}";
    readonly 'view.usage': "用量";
    readonly 'view.scope.label': "统计范围";
    readonly 'view.scope.session': "本会话";
    readonly 'view.scope.tree': "含子会话";
    readonly 'view.back': "← 返回 {title}";
    readonly 'view.ttft': "平均首token";
    readonly 'view.speed': "token速度";
    readonly 'view.empty': "该会话暂无用量记录。";
    readonly 'view.chart.title': "趋势";
    readonly 'view.subagents.title': "子会话（{count}）";
    readonly 'view.subagents.none': "无子会话";
    readonly 'view.subagents.titleCol': "会话";
    readonly 'view.subagents.nested': "含 {count} 个子会话";
    readonly 'view.note': "注：token 与费用来自本插件的请求记录（安装后）；平均首token 与 token速度来自 DSH 会话投影（含安装前历史）。";
    readonly 'chip.tokens': "含子会话 token 用量 {value}";
    readonly 'chip.hitRate': "含子会话缓存命中率 {value}";
    readonly 'chip.cost': "含子会话费用 {value}";
    readonly 'quota.trigger': "供应商配额";
    readonly 'quota.panel': "供应商配额面板";
    readonly 'quota.tier.fiveHour': "5 小时";
    readonly 'quota.tier.weekly': "每周";
    readonly 'quota.tier.monthly': "每月";
    readonly 'quota.tier.balance': "余额";
    readonly 'quota.resetIn': "{time} 后重置";
    readonly 'quota.updatedAt': "更新于 {time}";
    readonly 'quota.retry': "重试";
    readonly 'quota.error.auth': "鉴权失败（{message}）；请检查该供应商的 API Key。";
    readonly 'quota.error.noCredential': "未解析到 API Key（{ref}）；请先在供应商设置中配置密钥。";
    readonly 'quota.error.http': "供应商接口返回错误（{message}）。";
    readonly 'quota.error.network': "网络错误（{message}）。";
    readonly 'quota.error.parse': "响应解析失败（{message}）。";
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