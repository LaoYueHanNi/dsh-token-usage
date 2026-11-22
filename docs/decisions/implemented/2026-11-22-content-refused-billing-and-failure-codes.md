# DR: 补齐 CONTENT_REFUSED 等新错误码本地化与拒绝前用量计费

Status: implemented

## Problem

DSH `0.2.2-rc.3`（`deepseek-refusal-code`）在 `LLM_FAILURE_CODES` 中新增了 `CONTENT_REFUSED`（内容安全拒绝）以及 `ACCOUNT_QUOTA`、`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID` 等内置失败码，并且 DeepSeek 适配器在检测到 `stop_reason === 'refusal'` 时会先 `yield { type: 'usage', usage }` 再抛出 `CONTENT_REFUSED`（拒绝前已生成的 token 照常计费）。

本插件此前存在两处缺口：

1. [format.ts](../../../src/client/format.ts) 与 [locales.ts](../../../src/client/locales.ts) 仅映射旧版 17 个失败码，`CONTENT_REFUSED` 与账号/模型类新码直接显示原始英文枚举名。
2. 计费采集丢失拒绝前用量：
   - **辅助流**（[src/index.ts](../../../src/index.ts) 的 `llm/stream` 监听器）：遇到 `failure !== undefined` 一律只打警告不写行，丢弃了 `CONTENT_REFUSED` 伴随的 `usage`。
   - **主对话流**（[usage-record.ts](../../../src/usage-record.ts)、[src/index.ts](../../../src/index.ts)、[sync.ts](../../../src/sync.ts)、[stats.ts](../../../src/stats.ts)）：上游 `agent-loop` 会将拒绝流内收到的 `usage` 随 `assistant/attempt` 落盘，但本插件未从 `assistant/attempt` 提取 `usage`，且 `addUsage()` 对 `kind: 'failure'` 直接提前返回，导致主对话被拒绝时已计费的 token 与费用完全漏记（与官方 `token-meter` 不一致）。

## Decision

1. **补全失败码中英文映射**：
   在 [format.ts](../../../src/client/format.ts) 的 `FAILURE_CODE_LABEL_KEYS` 与 [locales.ts](../../../src/client/locales.ts) 补充 `CONTENT_REFUSED`、`ACCOUNT_QUOTA`、`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID` 以及上游 `LLM_FAILURE_CODES` 中可在请求路径透出的新码（`CLIENT_UPGRADE_REQUIRED`、`IMAGE_OFFLOAD_REQUIRED`、`INVALID_RESPONSE`、`MODEL_SWITCH_COMPACTION_FAILED`、`MODEL_UNSUPPORTED`、`NO_ADAPTER`、`PI_AI_ERROR`、`REQUEST_HEADERS`、`UNKNOWN_MODEL`、`UNSUPPORTED_CONTENT`、`UNSUPPORTED_OPTION`、`UNSUPPORTED_REASONING_EFFORT`），共 33 个本地化码；未知未来码仍原文兜底。
2. **打通主对话流拒绝前用量计费（对齐官方 `token-meter`）**：
   - [usage-record.ts](../../../src/usage-record.ts) 新增纯函数 `extractUsageFromStream(stream)` 从 `assistant/attempt.stream` 提取最后一个有效 `usage` chunk；`recordFromTurnEnd`、`recordFromRetry` 与 `recordOfEvent` 支持传入可选的 `failureUsage` 写入 `kind: 'failure'` 行的 `usage`（`coerceRecord` 原已支持 `failure` 行保留 `usage`）。
   - [src/index.ts](../../../src/index.ts) 与 [sync.ts](../../../src/sync.ts) 在当前 `(turn, step)` 内跟踪尚未结算的 `assistant/attempt` `usage`：在 `step/start` 或 `assistant/message` 清空，在 `llm/retry` 或 `turn/end`（`reason.kind === 'error'`）时消费并附着到对应 `failure` 行（不在 `step/end` 清除，因为外层 `turn/end` 落在 `step/end` 之后）；`sync.ts` 仅在 `ownEvents` 内维护该状态，不跨 Fork 继承前缀。
   - [stats.ts](../../../src/stats.ts) 的 `addUsage()` 遇到 `kind === 'failure'` 时仍只增 `failures` / `failuresByCode`（不增 `requests`、不计 timing），若记录带有 `usage` 则累加四桶 token 进入全维度与 `rateRows` 计费；`requestSeriesOf()` 保留带 `usage` 的失败行，无 `usage` 的失败行仍被排除。请求池（[session-request-details.ts](../../../src/session-request-details.ts)）原已对带 `usage` 的记录计算费用并按非完成态排除低缓存误报。
3. **保留辅助流 `CONTENT_REFUSED` 计费**：
   [src/index.ts](../../../src/index.ts) 的 `llm/stream` 旁路监听器捕获 `finish` 失败或生成器抛错中的 `CONTENT_REFUSED`：当 `failure.code === 'CONTENT_REFUSED'` 且此前收到了有效 `usage`（`projectUsage(usage) !== undefined`）时，打日志说明保留计费并按 `kind: 'aux'` 正常入账；其余无 `usage` 或常规错误失败仍保持原样仅记日志不落盘。

## Alternatives considered

- **仅修辅助流 `CONTENT_REFUSED`，忽略主对话流** —— 放弃：绝大多数内容拒绝发生在主对话，且上游 `token-meter` 已从 `assistant/attempt` 统计主对话拒绝用量；只修辅助流会导致主账本与官方消耗持续不一致。
- **主对话拒绝时改为写一条额外的 `kind: 'request'` 行** —— 放弃：会虚增「成功请求数」，且与既有 `failure:<sessionId>:<seq>` 单事件一行的去重协调模型冲突。将 `usage` 附着在既有 `failure` 行上既保留失败归因，又能准确计费。

## Consequences

- 代价：带 `usage` 的 `failure` 行会在「失败数」与「总 token / 总费用」中同时体现（不计入成功请求数），需要测试覆盖其不被重复统计或跨重试串用。
- 换来：用户悬停可看到中文「内容安全拒绝」等精确失败原因；无论主对话还是辅助请求在 `CONTENT_REFUSED` 前产生的已计费 token 都能准确进入统计、曲线与账单费用。
