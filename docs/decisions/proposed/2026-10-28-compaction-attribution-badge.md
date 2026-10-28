# DR: 压缩后首请求的归因徽标：只标注，不改缓存判定

Status: proposed

## Problem

供应商的前缀缓存按内容哈希命中。宿主的压缩操作——`compaction/prune`（工具结果剪枝）与 `compaction/summary`（LLM 摘要）——会改写已进入上下文的消息内容，从改写点起整条前缀失效。失效的代价不落在压缩操作自己身上（剪枝不产生计费调用，见 [DR: 将上下文压缩请求计入统计](../implemented/2026-09-02-compaction-billing.md)），而是落在**紧随其后发出的正常请求**上：请求池里这些行显示为低命中（<50% 触发「缓存过低」），用户无法区分「供应商缓存表现差」与「宿主自己的压缩操作改写了前缀」。

实测证据（会话 `session-ae0b46e6`，2026-10-28 逐事件核验）：

- 17:12:40 step 边界触发 9 条 `compaction/prune`（`shadowedTokenCount` 合计 32229，`shadowedRange` 覆盖 seq 33–230，**最早改写点极靠前**）→ 其后第一个请求未缓存 98678 / 缓存读 1152，命中 1.15%，触发「缓存过低」。
- 17:50:15 `compaction/summary`（输出 2623 token，耗时 36 秒）→ 其后第一个请求未缓存 65522 / 缓存读 1152，命中 1.73%，同样触发「缓存过低」。
- **反例**：17:48:21 两条 `compaction/prune`（遮蔽 seq 377/389，**最早改写点 377 位于上下文很靠后位置**，其前 117760 token 前缀仍完整命中）→ 其后第一个请求命中 93.6%，完全正常。

三个样本合起来说明失效机制：**失效严重度是最早改写点位置的函数**——改写点越靠前，作废的前缀越长。「受压缩影响」不等于「缓存失效」。

插件现状（同日核验）：`request-observe.ts` 只消费 `compaction/start` / `compaction/summary` / `compaction/end`，`compaction/prune` 零消费（`src/` 下 `prune` 仅命中 `pruneCounters` 内存清理，与事件无关）；`recordOfEvent` 的 switch 同样无 prune 分支；`RequestCacheExclusion` 的九个排除理由（`wire.ts`）没有「前缀被改写」一类。因此受影响行一律按普通命中数据评估，归因信息完全缺失。

## Proposal

核心是一个**归因窗口**模型：每个会话维护「自上一条正常请求以来发生的压缩事件序列」。正常请求投影为请求池行时，若窗口非空，该行携带归因标注并清空窗口；窗口为空则无标注。prune 事件按同一 step 边界并为一簇（实测同毫秒连续追加），summary 事件单独成项。

这一个模型同时给出三个子决策：

- **只标第一发**：请求消费窗口后清空。其后同 turn 的后续请求前缀已进入新的缓存基线，不再标注（与实测吻合：失效只出现在簇后第一个请求）。
- **多源合并**：窗口可能同时含 prune 簇与 summary（一级剪枝未达标接二级摘要、中间无请求的路径），徽标仍是一枚，tooltip 列全部原因。
- **时序判定，无事务依赖**：窗口按事件流顺序维护。`compaction/prune` 没有 `compactionId`（实测 data 仅 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`，且 17:12:40 的 9 条剪枝无任何 `compaction/start` 伴随），事务关联不可行；插件也拿不到请求的实际 prompt，前缀比对同样不可行。

### 数据面

- 消费 `compaction/prune`：事件类型来自 `@deepseek-ai/dsh-compaction/types` 的声明合并（插件已 type-only import，无新依赖）。
- `UsageRecord` 新增可选归因字段，缺省 = 无标注，与 `kind` 字段同哲学（absent optional fields are omitted，旧 day 文件与旧版本双向兼容，无需迁移）。
- 归因项携带来源 kind（`prune` | `summary`）与量值（簇内 `shadowedTokenCount` 合计 / summary 的 `shadowedTokenCount`），供 tooltip 使用。

### 展示面

- 模型列旁一枚「压缩后」徽标，样式沿用现有 `kindLabel`（auxKind 徽标同款渲染位置）。
- tooltip 按 来源 kind 区分因果文案——剪枝：「工具结果剪枝改写了请求前缀」；摘要：「LLM 摘要替换了会话历史」——并附量值。徽标文字统一，不按来源拆分。
- **缓存评估零改动**：`assessRequestCache` 的 band / reason / eligibility 全部不动（延续 [DR: 请求缓存提示直接依据已报告数据](../implemented/2026-10-25-cache-hints-from-reported-usage.md) 的判定规则）。93.6% 命中的受影响行显示正常，1.15% 的显示「缓存过低」并由徽标解释原因。
- 客户端文案走 locale 字典 zh + en 双份（`verify-client-ui-i18n` 门禁），英文 sentence case。

### 采集面（live 与历史同构）

- 实时路径：`request-observe.ts` 消费 `compaction/prune` 维护窗口（现有 session 状态机的扩展）。
- 历史路径：`sync.ts` 重扫循环按 seq 顺序消费同一事件流，天然可维护同一窗口。归因依赖跨事件状态，投影入口（`recordOfEvent` 及其调用方）需把窗口状态显式传入或在调用方附加——两条路径必须共享同一实现。
- 已落盘的旧行不回填（理由见 Alternatives）。

## Alternatives considered

归因判定规则：

- **前缀内容比对**（对比请求实际上下文与剪枝后表面）——语义最准，但插件拿不到请求的实际 prompt，成本也高。放弃。
- **压缩事务关联**（挂到 `compaction/start` 的 compactionId 下）——`compaction/prune` 没有 compactionId，且实测存在无 `compaction/start` 伴随的独立剪枝路径。硬伤，放弃。
- **turn 级标记**（剪枝发生过的 turn 内所有请求都标）——turn 内后续请求的前缀已稳定、缓存正常，全标会误伤。放弃。

呈现形态：

- **只加徽标文字、无 tooltip**——用户看得到「压缩后」但不知道因果链，区分不了「宿主操作」与「供应商表现」。放弃。
- **独立压缩事件区块**（请求池之外单列压缩视角）——剪枝产出行即退回方案 1/2，与 [DR: 将上下文压缩请求计入统计](../implemented/2026-09-02-compaction-billing.md) 已定的「prune 不记账」口径冲突。放弃。
- **徽标文字按来源拆分（「剪枝后」「摘要后」两枚）**——字典与测试面翻倍，区分信息放 tooltip 已够。放弃。

缓存评估结论：

- **新增排除理由（如 `pruned-prefix`，band 变 `excluded`）**——实测反例（受剪枝但命中 93.6%）证明一刀切排除会把正常行移出评估、告警量失真。放弃。
- **降级（loss → low）**——同样建立在「受影响 = 失效」的错误前提上，失效程度取决于改写点位置。放弃。

持久化：

- **仅运行态（归因只存在于 live attempt）**——违背插件「live 与历史共享同一投影入口」的既有承诺，live 行有徽标、重扫行没有，行为分叉。放弃。
- **落盘 + 回填已落盘旧行**——`appendOnce` 幂等语义不更新已有行，回填需专门的 reconcile 机制重放全量事件再改写 day 文件，成本高。放弃；接受「实施前落盘的旧行无徽标」这一已知窗口。

## Acceptance criteria

- 回归会话 `session-ae0b46e6-6222-41c2-b734-a1128d0e4f7b`，live 与 full-sync 重扫两条路径均验证：
  - seq 284 行带「压缩后」徽标，tooltip 提工具结果剪枝及量值（9 条、合计 32229 影子 token）；
  - seq 397 行带徽标，tooltip 提剪枝（2 条、合计 4812），且**缓存 band 仍为 normal（93.6%）**——「只标注不改判定」的直接验证；
  - seq 414 行带徽标，tooltip 提 LLM 摘要；
  - 对照组（seq 250、seq 384 等压缩前的请求）无徽标。
- `assessRequestCache` 的现有测试零改动通过（判定未变的回归证明）。
- 无归因字段的旧 day 文件读取正常，缺省读作无标注。
- `verify-client-ui-i18n` 门禁通过（zh / en 双份，无硬编码文案）。
- `compaction/prune` 本身仍不产生请求池行。

## Risks

- **归因是启发式，不是失效断言**：失效严重度取决于最早改写点位置（seq 33 → 全失效 1.15%；seq 377 → 93.6% 正常）。tooltip 文案必须说「前缀被改写，缓存表现可能受影响」，禁止说「导致缓存失效」——否则高命中行的文案与事实矛盾。
- **量值口径**：harness 压缩决策的上下文估算（如步骤边界的 totalTokens、实际减量）不落会话事件，插件只能锚定 `shadowedTokenCount`。tooltip 量值须表述为「剪除消息的影子 token 合计」，不声称精确的上下文减量（实测同一簇的影子合计 32229 与实际减量并不相等）。
- **live / 重扫分叉**：窗口逻辑若在两条路径各写一份，徽标行为会分叉；必须共享同一实现（这正是拒绝「仅运行态」的弱化版风险）。
- **事件格式依赖**：prune 的 data 形状是 harness 私有约定，宿主升级可能改变；type-only import 让形状变更在编译期暴露而非运行期静默错读。
- **同簇判定**：并簇依赖「prune 紧贴 step/end → step/start」的时序事实（实测同毫秒）；若宿主改为分批追加，簇退化为「窗口内全部 prune」——标注仍正确，仅量值合并口径变粗。
- **跨 turn 边界**：turn 末压缩后、下一 turn 的首请求会被标注——前缀确实被改写，行为正确，但文案不应引入 turn 概念，避免用户以「turn = 干净状态」的预期误读。
