# DR: 压缩后首请求的归因标注：只标注，不改缓存判定

Status: implemented

## Problem

供应商的前缀缓存按内容哈希命中。宿主的压缩操作——`compaction/prune`（工具结果剪枝）与 `compaction/summary`（LLM 摘要）——会改写已进入上下文的消息内容，从改写点起整条前缀失效。失效的代价不落在压缩操作自己身上（剪枝不产生计费调用，见 [DR: 将上下文压缩请求计入统计](./2026-09-02-compaction-billing.md)），而是落在**紧随其后发出的正常请求**上：请求池里这些行显示为低命中（<50% 触发「缓存过低」），用户无法区分「供应商缓存表现差」与「宿主自己的压缩操作改写了前缀」。

实测证据（会话 `session-ae0b46e6`，2026-10-28 逐事件核验）：

- 17:12:40 step 边界触发 9 条 `compaction/prune`（`shadowedTokenCount` 合计 32229，`shadowedRange` 覆盖 seq 33–230，**最早改写点极靠前**）→ 其后第一个请求未缓存 98678 / 缓存读 1152，命中 1.15%，触发「缓存过低」。
- 17:50:15 `compaction/summary`（输出 2623 token，耗时 36 秒）→ 其后第一个请求未缓存 65522 / 缓存读 1152，命中 1.73%，同样触发「缓存过低」。
- **反例**：17:48:21 两条 `compaction/prune`（遮蔽 seq 377/389，**最早改写点 377 位于上下文很靠后位置**，其前 117760 token 前缀仍完整命中）→ 其后第一个请求命中 93.6%，完全正常。

三个样本合起来说明失效机制：**失效严重度是最早改写点位置的函数**——改写点越靠前，作废的前缀越长。「受压缩影响」不等于「缓存失效」。

决策前插件零消费 `compaction/prune`；`RequestCacheExclusion` 的排除理由也没有「前缀被改写」一类。受影响行一律按普通命中数据评估，归因信息完全缺失。

## Decision

核心是一个**归因窗口**模型：每个会话维护「自上一条普通请求以来发生的压缩事件序列」。正常请求投影为请求池行时，若窗口非空，该行携带归因标注并清空窗口；窗口为空则无标注。窗口内的全部 prune 并为一簇（真实会话日志核验：prune 批次与滞留的 `tool/result` 在同一 step 边界交替追加，非压缩事件一律不拆簇），summary 事件单独成项并分隔其前后的簇。

这一个模型同时定了三个子决策：

- **只标第一发**：请求消费窗口后清空。其后同 turn 的后续请求前缀已进入新的缓存基线，不再标注（与实测吻合：失效只出现在簇后第一个请求）。
- **多源合并**：窗口可能同时含 prune 簇与 summary（一级剪枝未达标接二级摘要、中间无请求的路径），标注仍是一段归因，tooltip 列全部原因。
- **时序判定，无事务依赖**：窗口按事件流顺序维护。`compaction/prune` 没有 `compactionId`（实测 data 仅 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`，且实测 9 连剪枝无任何 `compaction/start` 伴随），事务关联不可行；插件也拿不到请求的实际 prompt，前缀比对同样不可行。

### 数据面

- 窗口实现是 `src/compaction-attribution.ts` 的 `CompactionAttributionWindow`（纯内存状态机，无 I/O），归因项携带来源 kind（`prune` | `summary`）、簇内事件数与 `shadowedTokenCount` 合计；事件类型来自 `@deepseek-ai/dsh-compaction/types` 的声明合并（type-only import，无新依赖）。
- `UsageRecord` 新增可选字段 `compactionAttribution`，缺省 = 无标注，与 `kind` 字段同哲学（absent optional fields are omitted，旧 day 文件与旧版本双向兼容，无需迁移）；`coerceRecord` 逐项防御性读取，非法项丢弃、幸存为空则读作无标注。
- 归因只落在普通请求行上：compaction 行是改写操作自己的计费行，failure 行没有可解释的缓存数据——它们的窗口保留到下一个普通请求（前缀改写仍先于它）。

### 展示面

- **无独立徽标**（初版「压缩后」徽标经真实复现反馈移除——与「缓存过低」标记并列显冗余）：归因因果与量值合并进**缓存命中格的 tooltip**，与低命中解释、排除理由共用一格；loss 行「缓存过低」标记的 tooltip 同样以归因段收尾（`RequestPool.tsx` 的 `hitTooltipOf`）。
- tooltip 按 来源 kind 区分因果文案——剪枝：「工具结果剪枝改写了请求前缀（N 条，剪除消息的影子 token 合计 X）」；摘要：「LLM 摘要替换了会话历史（影子 token X）」——前置句说明「宿主的压缩操作改写了上下文前缀，缓存表现可能受影响」。文案走 locale 字典 zh + en 双份（键集编译期对齐 + typecheck/test 门禁），英文 sentence case。压缩调用行既有的「压缩」kind 徽标保持不变。
- **缓存评估零改动**：`assessRequestCache` 的 band / reason / eligibility 全部不动（延续 [DR: 请求缓存提示直接依据已报告数据](./2026-10-25-cache-hints-from-reported-usage.md) 的判定规则）。93.6% 命中的受影响行显示正常（仅命中 tooltip 带归因段），1.15% 的显示「缓存过低」并由同格 tooltip 解释原因。

### 采集面（live 与历史同构）

- 实时路径：`index.ts` 的录制监听器为每个会话维护一个窗口（与 lastModel/lastProvider 同样的 per-session 状态），在 `recordOfEvent` 产出普通请求行时附加并消费。
- 历史路径：`sync.ts` 重扫循环按 seq 顺序逐事件喂同一实现，同样的附加规则。归因落在持久化行上，请求池合并（live attempt ↔ 持久化行）后自然显示，运行态观察器（`request-observe.ts`）不需要感知归因。
- 已落盘的旧行不回填（理由见 Alternatives）。

## Alternatives considered

归因判定规则：

- **前缀内容比对**（对比请求实际上下文与剪枝后表面）——语义最准，但插件拿不到请求的实际 prompt，成本也高。放弃。
- **压缩事务关联**（挂到 `compaction/start` 的 compactionId 下）——`compaction/prune` 没有 compactionId，且实测存在无 `compaction/start` 伴随的独立剪枝路径。硬伤，放弃。
- **turn 级标记**（剪枝发生过的 turn 内所有请求都标）——turn 内后续请求的前缀已稳定、缓存正常，全标会误伤。放弃。

呈现形态：

- **只加徽标文字、无 tooltip**——用户看得到「压缩后」但不知道因果链，区分不了「宿主操作」与「供应商表现」。放弃。
- **独立「压缩后」徽标**——初版落地形态（模型列旁、auxKind 同款样式）；真实复现（200k 会话 16 连剪枝 + 摘要）反馈：与「缓存过低」标记并列显冗余、挤压模型名，且剪枝信息只在 tooltip 里，徽标本身无信息量。迭代为命中 tooltip 合并形态，徽标移除。
- **徽标文字按来源拆分（「压缩-剪枝」「压缩-摘要」）**——受影响行常是多源合并（一级剪枝未达标接二级摘要），单枚文字装不下双源；且区分信息放 tooltip 已够。放弃。
- **独立压缩事件区块**（请求池之外单列压缩视角）——剪枝产出行即退回前两条路，与 [DR: 将上下文压缩请求计入统计](./2026-09-02-compaction-billing.md) 已定的「prune 不记账」口径冲突。放弃。

缓存评估结论：

- **新增排除理由（如 `pruned-prefix`，band 变 `excluded`）**——实测反例（受剪枝但命中 93.6%）证明一刀切排除会把正常行移出评估、告警量失真。放弃。
- **降级（loss → low）**——同样建立在「受影响 = 失效」的错误前提上，失效程度取决于改写点位置。放弃。

持久化：

- **仅运行态（归因只存在于 live attempt）**——违背插件「live 与历史共享同一投影入口」的既有承诺，live 行有徽标、重扫行没有，行为分叉。放弃。
- **落盘 + 回填已落盘旧行**——`appendOnce` 幂等语义不更新已有行，回填需专门的 reconcile 机制重放全量事件再改写 day 文件，成本高。放弃；接受「实施前落盘的旧行无标注」这一已知窗口。

## Consequences

- 代价：归因是启发式，不是失效断言——失效严重度取决于最早改写点位置（seq 33 → 全失效 1.15%；seq 377 → 93.6% 正常）。tooltip 文案只能说「前缀被改写，缓存表现可能受影响」，禁止说「导致缓存失效」，否则高命中行的文案与事实矛盾。
- 代价：量值只能锚定 `shadowedTokenCount`——harness 压缩决策的上下文估算（步骤边界 totalTokens、实际减量）不落会话事件，且实测同一簇的影子合计 32229 与实际减量并不相等，tooltip 表述为「剪除消息的影子 token 合计」，不声称精确减量。
- 代价：实施前落盘的旧行无标注（不回填）；宿主升级若改变 prune 的 data 形状，靠 type-only import 在编译期暴露；簇口径是「窗口内全部 prune 合计」（真实日志证实 prune 与 tool/result 交错追加，无法按 step 边界精确分批），tooltip 的量值因此是合并口径；turn 末压缩后下一 turn 首请求会被标注（前缀确实被改写，文案不引入 turn 概念）。
- 换来：用户能区分「供应商缓存表现差」与「宿主压缩改写了前缀」——命中 tooltip 的归因段给出因果链与量值，表内不增行内标记；缓存评估口径零改动（`assessRequestCache` 现有测试零改动通过），93.6% 反例行保持 normal；live 与重扫共享 `CompactionAttributionWindow` 同一实现，两条路径行为不分叉；旧 day 文件双向兼容，缺省读作无标注；`compaction/prune` 本身仍不产生请求池行。窗口状态机、两条采集路径、round-trip 与 tooltip 合并形态（含 93.6% 反例与 loss 行形态）由 `tests/compaction-attribution.spec.ts` 与 `tests/usage-view.client.spec.tsx` 覆盖。
