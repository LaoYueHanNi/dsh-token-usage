# DR: 用量行记录整段延迟与首字延迟，并支持历史数据补全

Status: implemented

## Problem

用量日志（`YYYY-MM-DD.jsonl`）先前仅持久化模型 ID、时间戳、会话 ID 和 Token 分桶数值，缺少请求级性能耗时指标。调用端无法得知单次请求的真实网络和响应表现：

- 整段用时（从发出请求到消息落地）未知，难以发现异常慢请求；
- 首字耗时（TTFT，从发出请求到收到第一个有效 chunk）未知，无法衡量模型流式首包的感知延迟；
- 既有的日文件历史记录没有该字段，若只修改新写入逻辑，存量日文件与新文件结构不齐，且历史记录因 `requestId` 判重直接跳过，存量数据永远无法补齐。

## Decision

1. **字段定义**：`UsageRecord` 增加两个可选数值字段（单位毫秒）：
   - `latencyMs`：整段延迟，`step/start` → `assistant/message` 的毫秒差值；
   - `firstTokenLatencyMs`：首字延迟，`step/start` → 首个包含有效增量（`isTokenDelta`，支持独立 `assistant/chunk` 及持久化 `assistant/message.data.stream` 压缩记录）的毫秒差值。
   - 缺省约束：非流式直出（无有效 chunk）、异常中断或压缩摘要请求（compaction）中无法准确取得的值保持缺省（omitted），不填 `null` 或伪造数值。

2. **实时采集**：在 `ctx.on('session/event')` 内部维护会话步级活跃状态表 `activeSteps`：
   - 监听到 `step/start` 记录起点时间戳；
   - 监听到首个有效 `assistant/chunk` 记录首字时间戳（若未派发分立 chunk，则在 `assistant/message` 结算时从 `event.data.stream` 解析首字）；
   - 监听到 `assistant/message` 结算差值并组装入行写入；
   - 遇到 `step/end` 或 `turn/end` 清理状态，防止中断泄漏。

3. **历史扫描与同步**：`syncHistory` 遍历会话事件时，按同等状态折叠提取每个 step 的两个延迟字段。全新安装时在 `state.json` 一并打上 `timingSyncedAt`。

4. **存量日文件后台补全**：`UsageLog.prototype.backfillTiming` 在启动后台异步执行：
   - 扫描所有本地日文件，识别缺少 `latencyMs` 或 `firstTokenLatencyMs` 的普通请求行；
   - 按 `sessionId` 批量从 `persistence` 检索原始事件流折叠补全对应字段（支持从紧凑 `stream` 解析首字）；
   - 利用 `.tmp` 临时文件加原子重命名（`rename`）重写受影响日文件，保持畸形行不丢；
   - 完成后打上 `timingSyncedAt` 标记，后续启动零成本跳过。

## Alternatives considered

- **推算估算值（按 Token 数除以平均 TPS 模拟）** —— 并非物理真实耗时，失真严重，不能反映真实网络波动与服务端排队。否决：采纳与 DSH 核心同构的事件物理时序差值。
- **重写 `UsageLog.record` 的去重逻辑** —— 若放开 `seen.has` 允许重复追加或就地行级修改，会破坏追加日志并发队列的简洁性并引入文件并发写入竞态。否决：通过独立的 `backfillDayFilesTiming` 批量原子修补。
- **强制全量清空重建 JSONL** —— 若用户历史会话已被外部删除，全量重建会导致已删除会话的用量数据永久丢失。否决：基于现有日文件增量就地填补。

## Consequences

- **所得**：每条对话请求记录均拥有精确到毫秒的端到端耗时与首字延迟；老用户无感平滑升级，历史日文件自动补齐；新老数据格式完全一致。
- **代价**：老版本升级后首次启动需多一次日文件扫描及针对缺项会话的原始事件检索与原子重写（仅执行一次）。
- **代价**：`UsageRecord` 的 JSONL 单行体积略微增加（多了两项数字 key）。
