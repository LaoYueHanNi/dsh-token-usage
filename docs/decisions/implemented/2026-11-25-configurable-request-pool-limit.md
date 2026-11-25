# DR: 实时请求池上限支持插件设置配置（requestPoolLimit）

Status: implemented

## Problem

会话「用量」页签底部的「实时请求」池原先在 [session-request-details.ts](../../../src/session-request-details.ts) 与 [wire.ts](../../../src/wire.ts) 中硬编码截断为 `REQUEST_POOL_LIMIT = 20`（顶部 1 条最新请求 + 下方最多 19 条历史）。对于长对话用户，20 条不足以回溯稍早的请求明细与缓存命中变化，无法在插件设置里按需扩大。

## Decision

1. **边界与共享解析**（[wire.ts](../../../src/wire.ts)）：保持 `REQUEST_POOL_LIMIT = 20` 为默认值，新增 `REQUEST_POOL_LIMIT_MIN = 1`、`REQUEST_POOL_LIMIT_MAX = 1000` 及 `resolveRequestPoolLimit()`；仅影响请求池展示裁切，不改变日志落盘、汇总统计或趋势图。
2. **服务端热读取配置**（[index.ts](../../../src/index.ts)、[stats-route.ts](../../../src/stats-route.ts)、[session-request-details.ts](../../../src/session-request-details.ts)）：
   - `Config` 新增 `.volatile()` 字段 `requestPoolLimit`（schema 限定 `1–1000`，`validateConfig` 校验整数范围）；
   - `createStatsRoute` 通过 `options.requestPoolLimit` thunk 每次请求读取最新配置并传给 `buildSessionRequestDetails({ ..., limit })`，返回的 `requestDetails.limit` 即时反映生效上限，无需重启插件。
3. **插件设置卡片表单支持**（[card-form.ts](../../../src/client/card-form.ts)、[TokenUsageCard.tsx](../../../src/client/TokenUsageCard.tsx)、[locales.ts](../../../src/client/locales.ts)）：
   - `CardForm` 单独维护 `requestPoolLimit` 的草稿文本、覆盖标记与整数校验；合法输入以 `number` 写入 `configForms`，留空保存时 `unset` 恢复默认 `20`，且该字段脏状态不阻塞「同步定价表」按钮；
   - 输入非法值时实时显示范围报错并仅禁用「保存」按钮，保持「放弃」按钮可用。

## Alternatives considered

- **在前端请求池卡片加「加载更多」分页接口** —— 会话统计目前由 `/token-usage/stats` 单接口返回完整快照，新增分页端点和客户端合并状态会增加协议复杂度；而且 `.poolTableWrap` 已自带限高滚动容器，直接放宽配置上限即可满足回溯需求且零前端重构。
- **不设上限或仅作组合配置** —— 放任极大值可能让单次响应与 DOM 渲染几千行卡顿；结合 `.volatile()` 表单暴露给普通用户并限定 `[1, 1000]` 整数范围兼顾灵活与安全。

## Consequences

- 代价：调大 `requestPoolLimit`（例如设为 `500`）会对应增大单次 `fields=session` 响应体与表格行数。
- 换来：默认行为保持 `20` 完全兼容，用户可在插件配置页按需调大并即时生效。
