# DR: 将上下文压缩（compaction）请求计入 token 用量与费用统计

Status: implemented

## Problem

插件的统计口径是"每一次成功模型请求"，数据源为 `session/event` 的 `assistant/message` 事件（`src/usage-record.ts` 的 `recordFromEvent`）。但**上下文压缩（compaction）也是一次真实的 provider 计费调用**——summarize 请求读取整个会话历史（可达数十万 token）并生成摘要，其 token 消耗与费用此前完全未被记录：

- 真实数据实证（2026-09 扫测 `$DSH_HOME/sessions/` 114 个会话、5598 条 assistant/message）：共发现 **4 次 `compaction/summary`，全部携带 `usage`**，单次输入高达 284,555 tokens（`opencode-go/deepseek-v4-flash`），另有 `cacheReadTokens` 274,688 的实例。这些调用按现行计价链本应产生可观的费用（如 DeepSeek v4 输入 ¥2/百万 × 28 万 ≈ ¥0.57/次），但统计页完全不显示。
- 官方文档依据：`03-参考_Reference/02-生成参考/03-持久化事件.md` 定义 `compaction/summary` 事件携带 `provider`/`model`/`usage?: TokenUsage`/`shadowedTokenCount`，注释原文："`Provider-reported token usage for the summarization request, when emitted`"。token 计量没有独立 usage 事件，usage 内嵌于 `assistant/message` 与 `compaction/summary` 两处。
- 现状确认：`src/sync.ts` 的 `syncHistory` 与 `src/index.ts` 的实时监听都只处理 `assistant/message`，`compaction/*` 事件被完全跳过；`UsageRecord`（requestId/time/sessionId/model/usage）没有表达"压缩请求"的字段。

## Decision

`compaction/summary`（带 `usage` 的压缩总结请求）计入记账链；`compaction/prune`（无 provider 调用的纯裁剪，只有启发式 `shadowedTokenCount`）**不记**——它不是计费调用，其量是"被移除上下文的影子价格"，统计口径是"provider 计费"，不应混入 token 消耗。

### 1. 记录模型：`UsageRecord` 的 `kind` 维度（`src/usage-record.ts`）

- `UsageRecordKind = 'request' | 'compaction'`；`UsageRecord.kind?` 可选，**磁盘语义为缺省 = `request`**：普通行的序列化不写该键（与"absent optional fields are omitted"的行哲学一致），只有压缩行写 `kind: 'compaction'`。`coerceRecord` 归一——仅当 `kind === 'compaction'` 时保留该键，缺省、未知值（未来新种类）与旧行一样读作普通请求，**未知 kind 不丢行**。旧 day 文件与 rollup 的 `recent` 双向兼容，无需迁移。
- **压缩行的 `requestId` 为 `compaction:<sessionId>:<seq>`**（seq = 事件的持久序号）。提案期曾以 `compaction:<sessionId>:<compactionId>` 为第一选择；落地时直接采用 seq 形态：`SessionEvent.seq` 是类型系统背书的"会话内单调唯一序号"，而 `CompactionId` 是无校验的 opaque branded string（`brand.ts` 注明 "no validation is performed"），唯一性依赖后端 mint 实现。seq 由 `recordFromCompaction` 天然持有，dedupe 语义等价且无实施期不确定。
- `recordFromCompaction(event, sessionId)`：`model = event.data.model`（summarize 调用的模型）、`usage = projectUsage(event.data.usage)`；**usage 缺失或非法返回 null，事件不记**——无 usage 的压缩无法计费，且 `shadowedTokenCount` 不是计费口径。
- 类型可见性：`usage-record.ts` / `sync.ts` / `index.ts` 各有一行 `import type {} from '@deepseek-ai/dsh-compaction/types'`（declaration merge 进程序，运行时零依赖），`@deepseek-ai/dsh-compaction` 进 devDependencies。

### 2. 实时采集与历史回填

- `src/index.ts` 的 `session/event` 监听改为三分支：`assistant/message` → `recordFromEvent`；`compaction/summary`（开关开）→ `recordFromCompaction`，null 跳过；其余 return。
- `src/sync.ts` 的 `syncHistory` 事件循环同样加 `compaction/summary` 分支；`SyncDeps` 加 `recordCompaction?: boolean`（缺省 true），首次安装回填与手动 full-sync 都经它控制。dedupe 由 `UsageLog` 的 requestId 全局集合保证（压缩行前缀 `compaction:` 含 sessionId，跨会话唯一）。

### 3. 统计并入（`wire.ts` / `stats.ts` / `rollup.ts`）

- `UsageTotals` 加可选键 `compactions?: number`（该组内压缩请求次数；普通请求数 = `requests - (compactions ?? 0)`）。`requests` 计**全部** provider 计费调用，客户端零改动即可展示正确总数。
- `emptyTotals()` 显式带 `compactions: 0`；`addTotals` 以 `(a ?? 0) + (b ?? 0)` 合并（旧 rollup 缺键防 NaN）；`addUsage` 改收 record、`kind === 'compaction'` 时计数。token 四桶与费用全部并入——`attachCosts` 计价链零改动，压缩行按其 model + time + input-side tokens 走同一 time-rule/tier/slot 链，巨大 input 自然落高 tier，与真实计费一致。
- `isTotals` 零改动（固定键 `every` 校验，多余键天然放行）；旧 rollup（无 `compactions`）读回参与合并正常。

### 4. 同步后的派生态失效

`UsageLog.appendOnce` 按**当前时钟**分桶写文件，回填行落在回填当天的 day 文件（hot，每次 stats 全量重读）——提案期"写入旧日期文件被 rollup 吸收"的表述与实际机制不符。真正要防御的是**跨午夜 sync** 的边缘窗口：午夜前写入的文件午夜后变 frozen，若中途 stats 读取已把 rollup `upto` 推过该日，追加行会被 `day <= upto` 跳过；record-cache 的 frozen 缓存同理可能 stale。补偿：`autoSyncIfNeeded` / `triggerFullSync` 完成回调在 `added > 0` 时 `clearRecordCache(dir)` + 删除 `rollup.json`（及 `.tmp`）——两者都是派生态，下次 stats 读无损重建；`ROLLUP_FILE_NAME` 自 `rollup.ts` 导出为单一权威。

### 5. 配置开关

`recordCompaction?: boolean`（默认 `true`）加进 `Config` interface、schemastery schema 与 `validateConfig`；`false` 时实时监听与回填双路径都跳过 `compaction/summary`。默认开启保证新老用户费用口径一致。

## Alternatives considered

- **只做实时采集、不做历史回填补记** —— 安装后的压缩计入，历史压缩仍然缺失；现有功能（首次回填、手动 full-sync）的承诺是"安装前历史补全"，口径不一致会让用户困惑。否决：两条路径同构，改动量相近。
- **把 `shadowedTokenCount`（被替换上下文）也计入"消耗"** —— 它是 token-meter 的启发式影子价格，表示被压缩移除的上下文量，不是 provider 计费项；计入会让"消耗"与"费用"双口径失实（同一批 token 先计费再被压缩又计一次）。否决；如需"上下文压力"视角，应另立指标而非并入账本。
- **`compactions` 不单独计数、只并入 totals** —— `requests` 直接含压缩，客户端零字段改动；代价是无法区分"对话请求数"。实现了 `compactions` 可选键（约 3 行），README 说明口径，客户端暂不展示。
- **新增独立事件类型/独立文件（如 `usage-compaction.jsonl`）** —— 破坏 `UsageLog` 单一存储与 dedupe 语义，rollup/迁移/统计全要分支；`kind` 列是一行级标记，侵入最小。否决。
- **`requestId` 用 `compactionId`** —— 提案期的第一选择；因 `CompactionId` 是无校验的 opaque string（唯一性依赖后端 mint 实现），落地为事件 seq 形态（持久层保证会话内唯一），见 Decision 第 1 节。

## Consequences

- **所得**：统计口径补全为"全部 provider 计费调用"。真实扫测中的 4 次压缩（单次 input 最高 28 万 token）在 full-sync 后进入统计页——费用、token 四桶、per-model 表、会话视图自动包含；计费链（tier/slot/time-rule、`pricing.json` 覆盖、重新定价）复用，无新代码路径。
- **所得**：`compactions` 可单独读出（wire / rollup 均带），为将来客户端区分"对话请求 / 压缩请求"留了数据面。
- **代价**：压缩请求 input 巨大，tier 计费档位可能与用户直觉不符（如 `≥512K` 档）——与真实计费一致即为正确，README 已注明按实际 input 计档。部分 provider 的压缩请求可能走特殊路由/折扣（如 opencode-go 套餐内不计费）——插件按 `pricing.json`/云端镜像计价、不感知套餐，是既有计价边界。
- **代价**：`emptyTotals` 显式带 `compactions: 0` 使 wire/rollup 输出多一个键；旧断言式测试的 totals fixture 需补键（机械改动）。`sync` 后 `added > 0` 时重建 rollup 是全目录重读，量级秒级、只在手动 full-sync / 首次安装触发，实时路径不触发（当日文件不落 rollup）。
- **边界**：无 usage 的压缩事件不记（无法计费）；`compaction/prune` 永不记（非计费调用）。
