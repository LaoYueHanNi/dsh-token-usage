# DR: 记录并单独展示辅助模型请求（自动审查 / 标题生成 / 推理翻译）

Status: implemented

## Problem

插件的用量账本只从会话事件投影：`assistant/message`（主对话请求）、`compaction/summary`（压缩摘要）、`turn/end` 与 `llm/retry`（失败）。但 DSH 里还有一类旁路模型调用：`@deepseek-ai/dsh-experimental-auto-review` 在每次工具调用前用当前 agent 的模型做一次授权审查，`@deepseek-ai/dsh-session-title-llm` 为会话生成标题，`@deepseek-ai/dsh-experimental-translator` 翻译推理内容。它们都由宿主包直接调用 `ctx.llm.stream()`，既不经过 agent 循环，也不产生任何会话事件，因此插件完全看不到，统计与费用系统性偏低。

实测证据（DSH 0.2.1-rc.2，当前会话）：权限模式切到「自动审查」后，会话日志有 72 次 `tool/call`（每次对应一次 reviewer 请求），而插件账本中该会话只有 53 条记录，且 53 条 requestId 与会话内 53 条 `assistant/message` 一一对应——reviewer 请求一条未记。这类请求的用量在 DSH 侧没有任何持久化（标题生成只留 `session/title-llm-request` 请求参数、没有 usage），所以历史漏记无法回补，只能从升级后开始记录。

## Decision

采集点改为模型服务的统一入口：插件监听 `llm/stream` waterfall。dsh-llm 的 `LlmRuntime.stream` / 已准备调用的 `stream()` 都经过 `ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))`，且该 waterfall 是同步组合——监听器同步返回一个**原样透传的 async generator**：逐步 `yield` 上游 chunk、记住 `usage` chunk 与终止 `finish`，流结束后（fire-and-forget）向当前数据目录追加一行 JSONL。不消费、不改写、不延迟任何 chunk。

分类不依赖宿主新增导出（`isAgentLoopRequest` 等），避免低版本 DSH 缺 API 时插件加载失败：有 `sessionId` 的请求属于主对话（已由 `assistant/message` 记录）或压缩/标题（`purpose` 明确），无 `sessionId` 的旁路请求再按固定 system 提示词识别——`REVIEW_POLICY` 开头是自动审查，`Translate the following text` 开头是推理翻译，其余落 `other` 兜底类别（首次出现打一条日志，便于发现宿主新增旁路调用点）。请求没有 `purpose` 标记时不做猜测式归属。

记录行：`kind: 'aux'` + `auxKind: 'auto-review' | 'session-title' | 'translation' | 'other'`，`sessionId: ''`（旁路调用没有会话归属），`model` 为请求实际路由，usage 为 provider 上报的四桶，`requestId` 为 `aux:<kind>:<流开始毫秒>:<进程内计数>`。成功的流才写行；失败/取消的流没有计费 usage，只写插件警告日志（含失败码），不落数据。配置新增 `recordAux`（默认 `true`，composition-only，与 `recordCompaction` 并列）可关闭采集。

聚合口径（用户口径：计入总消耗、按模型包含、按会话无法关联则不含）：

- 辅助记录进入 `total`、`byDay`、`byHour`、`byModel`、`rateRows`、`recent`——总额、趋势图、按模型表、成本底账都把它当真实计费请求；
- 不进入 `bySession` / `sessionRows`——没有会话可归属，按会话表与会话用量页签、输入栏胶囊都保持对话口径；
- 另设 `auxRows`（kind × day × model × rate）与 `AuxSummary`（按 kind 汇总 + 成本），只为设置页「运行开销」页签提供拆分；该维度与 `rateRows` 冗余但互不影响，避免为了拆分而绕开既有定价与筛选链路；
- 日期筛选对辅助请求生效；模型筛选同样作用于辅助请求（其 `model` 是真实路由），因此运行开销页签与筛选后的总量、按模型表始终对得上。

展示：设置页统计卡不新增标注，费用 / 总 token / 命中率 / 四桶 / 成功请求数直接把辅助请求合入；明细维度切换在「按模型 / 按会话」之外新增第三个页签「运行开销」——页签内先按类别（自动审查 / 标题生成 / 推理翻译 / 其他）汇总，类别行默认收起：行首是一个带折叠箭头的展开按钮（`aria-expanded` 标记状态），点击才在类别下逐行展开该类别实际使用的模型（同一组次数、费用、token 四桶列；模型明细沿用按模型表同一套 canonical 归一——`attachCosts` 在折叠时经 `canonicalName` 把定价表同一条 feed 行的各路由别名（如 `auto/…`、`zcode/…` 前缀名）合并成一行、显示 modelId，未定价名称保留原样不合并），各类别独立开合，最后是始终可见的合计行；无数据时显示空态提示（升级前的历史页面不出现假数据）。趋势图直接绘制合并后的数据，不区分序列、不加注记。按模型表包含辅助请求（审查开销体现在会话所用模型的请求数与成本里）；按会话表不含。

磁盘格式：`rollup.json` 新增 `auxRows`；旧 rollup 缺该字段读为空列表且不要求重建——写它的版本不可能记录过辅助行，因此不会丢失任何已吸收用量。降级时旧插件会把 `kind: 'aux'` 当作普通请求（计入模型/会话统计），属于已知的向下兼容偏差。

## Alternatives considered

- **从 `session/title-llm-request` 事件回填标题生成用量。** 该事件只有路由、system、messages 与 maxTokens，没有 usage；回填会得到零 token 的假记录，只能放弃。
- **要求 DSH 核心给 Auto review / 翻译请求加 `purpose` 标记后再采集。** 正确但不可控：跨仓库发布节奏、旧宿主仍需兜底，且插件无法假设用户会先升级宿主。文本前缀识别在宿主升级改提示词时只会落到 `other`，不会丢数据。
- **按调用上下文把 reviewer 请求归属到触发审查的会话。** 请求对象里没有 `sessionId`，只能靠异步上下文推断（Cordis/AsyncLocalStorage 时序不保证），且归属错误会污染会话成本；用户已明确「按会话做不到关联就不包含」，因此不实现。
- **辅助请求不进 `rateRows`，成本单独累计。** 那样按模型表要额外合并成本维度，模型筛选、日期重算、定价变更都要再走一遍，等于复制定价链路；选择直接让辅助行进入 `rateRows` / `byModel`，另设 `auxRows` 冗余维度只做拆分展示。
- **失败/取消的辅助请求也写行。** 失败调用没有 provider usage，写行只能计入请求数却拉低成功率分母，还会让「成功请求数」卡失去现有语义；用户选择失败只记日志，因此不落数据。
- **运行开销不提供任何拆分展示，只在总额里悄悄合并。** 用户能看到总额与实际账单对齐，但无法解释「模型表里为什么多出几十次请求」；明细页签是既不污染主口径又能审计的展示位置。
- **在总览卡上加「含运行开销」小字/趋势图加辅助序列。** 用户明确要求合入显示、不做标注；额外序列会让图表与按会话口径产生视觉冲突。

## Consequences

- 代价：识别依赖宿主提示词文本（`REVIEW_POLICY` / 翻译模板），宿主升级改文案时类别会落到 `other`（数据不丢、只影响分类）；`auxRows` 与 `rateRows` 存在冗余行（每天几十到几百行，可忽略）；旧版插件读新数据会把辅助行计入模型/会话统计；历史漏记不可回补，升级后第一个请求才开始记录；每次 tool call 多一行 JSONL（实测约为对话行数的 1–1.4 倍）。
- 换来：自动审查、标题生成、推理翻译的 token 与费用第一次进入账本；总额、趋势图、按模型表与真实账单同口径；「运行开销」页签可按类别审计它们，且会话表与会话用量页签保持纯对话口径；`recordAux` 可一键关闭采集。
