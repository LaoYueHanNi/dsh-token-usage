# DR: 跳过 DeepSeek chat 导入的历史事件并在全量扫描中提示忽略数

Status: implemented

## Problem

DSH 0.2.2 新增实验包 `deepseek-chat-import`，把网页版 DeepSeek 导出的对话直接写成普通会话日志（`inheritedEventCount = 0`、`isSeeded: false`），Fork 继承前缀过滤拦不住。导入日志里有两类事件不是真实的模型调用，旧实现却照样记账：

1. 每条导入的 `assistant/message` 固定写 `source = { provider: 'deepseek-chat-export', model: 'deepseek-chat-export' }`，且不带 usage。全量扫描会为它们落盘请求行，请求数虚高，模型表出现未定价的 `deepseek-chat-export` 告警，供应商表也多出 `deepseek-chat-export`。
2. 没有回复、未完成、模板回复或空回复的导入轮次会写成 `turn/end { kind: 'error' }`，错误码为 `DEEPSEEK_EXPORT_*`（`NO_REPLY`、`FAILED`、`TIMEOUT`、`TEMPLATE_RESPONSE`、`EMPTY_REPLY` 等）。这些被记成失败行，失败数和失败率虚高。

另外，`modelOfEvent` / `providerOfEvent` 会从导入消息读出 `deepseek-chat-export`，把会话的最近路由带偏，后续在真实路由确立之前发生的失败会挂到这个假模型上。

## Decision

1. `src/usage-record.ts` 新增 `isImportedHistoryEvent(event)`：provider 等于 `IMPORTED_CHAT_EXPORT_PROVIDER`（`'deepseek-chat-export'`）且 `projectUsage` 为空的 `assistant/message`，或错误码以 `IMPORTED_CHAT_EXPORT_FAILURE_PREFIX`（`'DEEPSEEK_EXPORT_'`）开头的 `turn/end` 错误，判定为导入历史。上游实验包不是本插件的依赖，因此常量在本地写死并注明来源。
2. `recordOfEvent()` 对导入历史返回 `null`，实时监听和历史同步两条路径共用这一处过滤；`modelOfEvent` / `providerOfEvent` 对导入消息不返回任何路由。用户在导入会话里继续聊天的新轮次带真实 provider / model / usage，照常记录。
3. `syncHistory()` 在调用 `recordOfEvent()` 之前统计被跳过的导入事件数，写入 `SyncResult.ignoredImported` 与进度 tick（为 0 时省略）。宿主透传到 `FullSyncView`，设置卡片的进度行和完成行追加「忽略 N 条 DeepSeek chat 导入记录」，宿主日志同步输出该计数。
4. 导入事件不进入 `reproduced`，旧版本已经记下的导入请求行与失败行属于可重建白名单，下一次全量扫描时由 `reconcile` 自动删除，删除前走 [改写前滚动备份](2026-11-22-reconcile-whitelist-and-rewrite-backup.md)，无需单独迁移。

## Alternatives considered

- **只在 `recordFromEvent()` 跳过导入消息（路线图原方案）** —— 放弃：漏掉 `DEEPSEEK_EXPORT_*` 失败行和最近路由被带偏两处污染；还要把 `recordFromEvent` 的返回类型改成可空，牵动所有调用方。
- **只过滤上游当前列出的 9 个错误码** —— 放弃：上游新增导出状态码时本插件就会漏判；`DEEPSEEK_EXPORT_` 前缀只由导入器使用，按前缀匹配不会误伤真实供应商失败。
- **依赖 `@deepseek-ai/dsh-deepseek-chat-import` 读取 `IMPORTED_MODEL_SOURCE`** —— 放弃：为一个字符串常量引入实验包依赖，代价不成比例，且实验包没有稳定承诺。

## Consequences

- 代价：路由键与错误码前缀在本地写死，上游改名时需要同步；清理已有污染行要用户执行一次「全量扫描同步」；`SyncResult`、`SyncProgressTick`、`FullSyncView` 新增可选的 `ignoredImported` 字段。
- 换来：导入的对话不再虚增请求数、失败数，也不再出现 `deepseek-chat-export` 模型或供应商；扫描结果明确告诉用户忽略了多少条导入记录，删除计数不再让人困惑。
