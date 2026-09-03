# DR: 失败请求按 provider 尝试计入统计，成功卡胶囊与按模型表 A/B 展示

Status: implemented

## Problem

统计页与用量 tab 只展示成功的 provider 计费调用（`assistant/message` + `compaction/summary`）。失败的模型请求对用户同样重要——限流、配额耗尽、上下文超限是真实发生的调用尝试，此前无从得知一个会话/一天里失败了多少次、败在哪一类。

数据源已存在且带结构化失败事实：`turn/end` 的 `reason.kind === 'error'` 携带 `LlmFailure`；`dsh-llm-retry` 救回的中间失败写在持久事件 `llm/retry`（同样带完整 `LlmFailure`），重试成功后 `turn/end` 是 `completed`。只认终态会系统性漏记主体（实测全量扫描「新增 0」，对照日志却有大量被救回的 `RATE_LIMIT`）。`assistant/message` 的 `interrupted?: true` 是被中止流的截断前缀，不是失败判定。

展示上失败不能再占一张独立卡：七卡会把窄面板挤成两排，和费用/命中率抢宽度。hover 直接打 `RATE_LIMIT` 是重试策略的机器词汇，用户对不上「限流」。

## Decision

失败按 **provider 尝试** 粒度记为正交的 `failures` 维度，不并入 `requests`、不计任何 token/费用。用量 tab 与设置页共用一张成功请求卡，失败收成卡内可 hover 的胶囊。

### 1. 记录模型（`src/usage-record.ts`）

- `UsageRecordKind = 'request' | 'compaction' | 'failure'`；失败行磁盘写 `kind: 'failure'`，`coerceRecord` 只在 failure 行保留该键（未知 kind 仍读作 request）。
- 双源都投影为失败行，共用 `requestId = failure:<sessionId>:<seq>`（seq 会话内单调唯一，两源不碰撞，重复 sync 去重）：
  - `llm/retry`：每一次调度重试的失败尝试都记（插件在等待前写入，退避中取消仍算那一次已失败的尝试）。`llm/retry-started` 是等待完成标记，忽略。
  - `turn/end` 且 `reason.kind === 'error'`：终态失败。`aborted` / `max-tokens` / `blocked` / `interrupted` 全部跳过。
  - 耗尽：N 次 `llm/retry` + 1 次 `turn/end` error，合计 N+1。救回：N 次 `llm/retry` + 1 次成功 `assistant/message`，`failures` 与 `requests` 不重叠。
- 无 usage。`model` 取会话最后已知路由（`modelOfEvent` 跟 `request/context` 与 `assistant/message`）；从未观察到路由时为 `''`——该行进总数、byDay、rateRows（日筛选不丢数），**不进 byModel / byHour**（空白表行会假装我们知道归属）。
- `failureCode` 取 `LlmFailure.code`（开放集合：可重试五码 + 终态三码 + `UNKNOWN`）。`coerceRecord` 只在 failure 行保留；非字符串/空串省略，聚合时缺码归 `UNKNOWN`。
- `recordOfEvent` 是 live 监听与 `syncHistory` 共用的投影入口，避免新源只落一条路径。

### 2. 采集路径

实时监听（`src/index.ts`）与 `syncHistory` 同构走 `recordOfEvent`。每会话维护最后已知模型（live 用 Map，回填用局部变量）。**不受 `recordCompaction` 开关控制**。类型可见性：`import type {} from '@deepseek-ai/dsh-llm-retry/types'`，包进 devDependencies。

### 3. 统计口径（`wire.ts` / `stats.ts`）

- `UsageTotals.failures` / `failuresByCode` 可选；`requests` 收紧为成功请求数。`addUsage` 对 failure 行直接 return，不进 token 桶。
- `emptyTotals()` 显式 `failures: 0`；`addTotals` 以 `?? 0` 合并，`failuresByCode` 键级合并、惰性创建。旧 rollup 无迁移。
- `requestSeriesOf` 排除失败行（没有 token，画出来只是零点锯齿）。
- 空态判定：`requests === 0 && failures === 0`。全程失败的会话仍渲染统计带。

### 4. 客户端展示

- `RequestsStatCard` 两处表面共用：标签 `stat.requests`（成功请求数），主数字是成功数，右侧胶囊 `stat.failuresPill`（`失败 {count}` / `Failed {count}`）。
- 零失败不渲染胶囊（`FailurePill` 在 `failures === 0` 时返回 `null`）：多数会话/模型本来没有失败，灰「失败 0」占位把「没有失败」读成一个需要扫视的状态。有失败时可键盘聚焦。
- Tooltip 包卡片胶囊，以及表里的红色 B。`failuresTooltip` 每行 `含义 ×count`，已知码走 `fail.{CODE}`（限流 / Rate limited 等九对），未知码原文兜底。排序：计数降序、码名字升序破平。
- `FailurePill` 只给成功请求卡。**两处按模型表**（用量 tab、设置页 Token 用量）该列不用胶囊，改三轨网格：左 `minmax(0,1fr)` 成功数右对齐、中 `/`、右失败数左对齐且错误色，斜杠落在列几何中线、行行对齐；`B === 0` 只打印成功数、不画 `/` 与 `0`（仍走左轨，与有失败的行对齐）；`B > 0` 可 hover / 聚焦。胶囊在密排数字列里与入/出/费用列不齐，hover 气泡还被单元格挤窄。表头同一套三轨 `成功 / 失败`（`stat.ok` / `stat.fail`），`aria-label` 仍是 `stat.successFail`。单元格仍读该行自己的 `totals.failures` / `failuresByCode`。子会话表不加失败列。
- 胶囊与气泡都不加粗（字重 400），字号 12px：对齐表内成功请求数，小于卡上 18px 主数字。气泡 `white-space: pre` + `width: max-content`，避免 CJK 在 shrink-to-fit 下按字折成竖条。选择器挂在 `.pillWrap` 上，卡片与表格同一覆盖。
- 用量 tab 保持六列定宽栅格（900px 断点三列）；失败不再占第七格，不必 auto-fit。
- 磁盘布局按事件日写入，见 [`2026-09-03-event-day-files`](./2026-09-03-event-day-files.md)。

## Alternatives considered

- **失败并入 `requests`、加 `successes` 反推** —— 破坏既有 `requests` 语义，费用/命中率/token 曲线都要再剔除失败行。否决：正交 `failures` 侵入最小。
- **以 `assistant/message` 的 `interrupted: true` 判失败** —— 那是被中止流的成功前缀（有 token），不是失败。否决。
- **按 `step/start`/`step/end` 配对** —— `step/end` 不带失败事实；重试发生在同一未关闭 step 内，配对拿不到 `LlmFailure.code`。否决：`llm/retry` 才是带码的权威源。
- **只记 `turn/end` error、忽略中间重试** —— 被救回的 RATE_LIMIT 等主体恒为漏记。否决：用户手动扫描已证伪。
- **只记 `llm/retry`、去掉终态** —— 预算耗尽或不可重试码（`QUOTA` 等）的最后一次尝试没有 `llm/retry`。否决：两源互补。
- **`llm/retry` 没有对应 `llm/retry-started` 时不记**（退避中取消） —— 原始尝试已经失败。否决。
- **失败行也带 usage** —— `turn/end` / `llm/retry` 本身不带 usage；从 chunk 回收属于重造 token-meter。否决。
- **独立失败卡（用量 tab 七卡 / 设置页五卡）** —— 窄面板挤成两排。否决。
- **卡内左右分栏 / 斜杠 `6,216 / 228` / 次行「失败 n」/ 总数当主角** —— 装不下、被读成比率、卡片永远更高、与表格「请求」列口径冲突。否决。
- **按模型表也用 FailurePill** —— 实看后和密排数字列不配。否决：数字 A/B。
- **按模型表拆成「成功」「失败」两列** —— 用量 tab 该表已八列，挤不下。否决。
- **按模型表零失败也画 `/0`** —— 多数行没有失败，`/0` 是噪声。否决：零失败只走左轨。
- **整格右对齐粘成 `2289/10`** —— 位数一变斜杠左右乱跳。否决：三轨网格让斜杠固定在列几何中线。
- **零失败保留灰胶囊占位** —— 0↔n 不跳布局，但占位把「没有失败」读成一个需要扫视的状态。否决；代价是首次出现失败时胶囊插入让该格/卡片变宽一次。
- **只藏表里的零失败、卡上仍留灰胶囊** —— 两处表面分叉。否决。
- **hover 直接打 `RATE_LIMIT` 或码和含义并列 / 另做图例** —— 机器词汇、气泡变宽、第二处文案。否决；磁盘仍存码。
- **把 shell Tooltip 全局改成 11px / 自研气泡** —— 配额按钮被带小，或重复定位逻辑。否决。
- **子会话表请求列也加胶囊** —— 本轮对标的是按模型列（与成功请求数同一口径的模型切片）；子会话行是另一维度。否决，避免和「本会话 / 含子会话」汇总卡重复。

## Consequences

- **所得**：两个表面都能看到成功数与失败数；hover 是人话分类（限流 ×23）；被救回的中间失败进入账本；全程失败的会话不再误显「暂无用量记录」。
- **所得**：成功率是 **尝试级**（一次成功 turn 若经历 3 次重试，是 1 成功 + 3 失败）；`failures` / `failuresByCode` 在 byDay/rateRows 都在，未来做失败趋势不必改聚合层。
- **代价**：always 模式无上限重试可把单会话失败数抬得很高——这是真实尝试次数。失败视觉权重低于独立卡。
- **代价**：成功请求卡（胶囊）与按模型表（A/B）不是同一视觉元件，两处表面要分头维护；0↔n 切换时胶囊插入让该格/卡片变宽一次。
- **代价**：上游新增 `LlmFailure.code` 时要补一对 `fail.*`，否则该行退回原文。`@deepseek-ai/dsh-llm-retry` 作为 type-only 开发依赖。
- **边界**：`model === ''` 的失败行只进总数不进模型表；气泡覆盖依赖 shell Tooltip 仍是 Fragment 兄弟而非 body portal。
