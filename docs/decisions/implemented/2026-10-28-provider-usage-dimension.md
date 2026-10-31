# DR: 按供应商统计维度

Status: implemented

## Problem

路由键已经落在用量行上并完成了历史回填（[DR: 保存供应商路由键并回填旧用量行](2026-10-28-provider-field-and-backfill.md)），但没有任何消费维度：用户看不到「每个供应商各花了多少 token 和钱」。展示名另存于数据目录的 `providers.json` 名册。回填决策的 Consequences 写明两件事：历史上有大量无法归因的行（升级前的辅助调用、会话日志缺失的死会话），做维度时**必须单列，不能当成某个供应商的零**；汇总与 rollup 聚合键**另立决策**——本决策就是那一条。

落地实测还确认了一个结构性事实：**有一批请求永远不会有 provider**——宿主的会话标题生成 bypass 调用发起时 options 不带路由键（升级首日的未标注组里就只有本会话的 6 条标题生成调用），审批请求同样在结构上不携带 provider。这批调用持续产生、无法归因也不是数据缺陷，任何「把未标注清零」的期待都不成立，维度的呈现必须面对它。

## Decision

聚合粒度先扩：`rateRows` 与 `bySession` 的每个 cell 增加 `provider` 键（`rateRowKey` / `sessionRowKey` 拼进 provider 段，空串为未标注组），`ROLLUP_AGGREGATE_FORMAT` 提到 4——旧 rollup 下次 stats 读即全量重建，provider 维度一次性回填全部吸收历史。新维度 `byProvider`（provider 路由键 → totals）：**空串是未标注组，永远保留为独立一行，排序固定沉底**，绝不并入命名供应商、绝不丢弃。

成本层从 rateRows 按 provider 分组累加（`attachCosts`），与 byModel 同源同价，价格表更新后重定价免费；未标注组同样有成本。`filterSummary` 的日期/模型筛选重聚合时同步重建 `byProvider`；`summaryForSessions`（history-incomplete 回退）从 session cells 重建。展示名不进行：路由每请求读 `providers.json` 名册，payload 带 `providerNames`（键 → 最新展示名），客户端 `providerLabel` 缺名退回键本身——与名册「最新名为准、不删旧路由」的语义一致。

`byProvider` 只有一个真相来源：rateRows。所有聚合路径（`summarizeRecords` / `mergeSummaries` / `filterSummary` / `summaryForSessions`）都从 rate cells 按 `row.provider ?? ''` 反推供应商组，合并时**不折叠**两侧的 `byProvider` 数组。折叠数组在两侧形状一致时与反推等价，但两侧形状不同——旧格式 rollup 读入时没有这个维度——就会分叉：那半边的用量进了 `total` 与 `rateRows` 却留在供应商表之外，连未标注组都接不住，「各供应商行之和 = 顶行」这条对账不变量随之被破坏；更糟的是同一份数据加与不加日期筛选会给出两张不同的供应商表（筛选路径本就由 rateRows 重建）。rollup 读入时若缺这个维度，与缺 `bySession` 一致地标记重建，让聚合从日文件重建一次把维度补齐。

UI（两个入口：设置面板与大屏，与会话用量页无关）：左侧插件入口的面板 tab 增加「按供应商」，大屏 token 用量页增加同款「供应商」卡——两者都渲染与按项目/按模型同语法的单行列表（展示名 | 相对条 | 总 tokens · 缓存占比 | 费用），排序在总 token 与费用间切换，两个入口各自持有独立的排序状态（设置面板与大屏是两个互不相干的组件实例，各有自己的 `useState`，在设置里切了排序不影响大屏）。未标注组渲染为**沉底的弱化行**，名旁带问号小标识，hover 列出无路由键的封闭原因集（会话日志已删除的历史会话、路由键字段加入前的旧会话、不带路由键的运行开销如标题生成与审批请求）——呈现上它是「已知的差额」而非 bug：各命名供应商行之和与顶行的差额随时在列表里对账，读懂数量级（例如全部日期下约 50M，其中 45M 是 8-17 三个日志已删除的重度会话）靠的正是这行与它的解释。按 provider 筛选不在本决策范围。

## Alternatives considered

- **不进 rateRows，`byProvider` 只在 `summarizeRecords` 现算。** 放弃：rollup 路径（全局读）拿不到该维度，等于只在会话页可用；且 provider × rate 的关联丢失后，供应商成本无法随价格表重定价，只能再抄一份定价逻辑。
- **未标注行按模型名前缀或「当前供应商」猜测归并。** 放弃：正是路由键决策明确拒绝的猜测；当成零会静默丢用量，请求数对不上顶行。
- **未标注行从聚合里丢弃。** 放弃：wire 上各供应商行之和会与顶行失衡，对账就没了；未标注行必须留在数据层。
- **未标注行完全不渲染。** 先落地后撤下再恢复：不渲染时顶行与列表的差额看不见去处，全部日期下约 50M 的差额反而更像丢数据；保留渲染但弱化沉底，问号 hover 把「为什么没有路由键」讲清楚，杂音变成了带解释的对账行。
- **展示名快照进 rollup。** 放弃：路由改名后要重写 rollup 才能更新展示；名册随 payload 每请求带最新值，改名即时生效且不用重建任何聚合。
- **provider 同时进 `byHour` / `auxRows` 粒度。** 放弃：没有消费方，白增 rollup 体积与合并复杂度；需要时再抬格式。
- **第一版就加 provider 筛选参数（`filterSummary` + UI 状态机）。** 放弃：筛选联动牵扯 UI 状态机与路由参数，先把维度落稳；有需求再立决策。
- **`byProvider` 维护成 rollup 独立持久化结构之外的实时重算。** 放弃：全局读每次重扫全部日文件，rollup 的存在意义就是这个缓存。
- **合并时折叠两侧的 `byProvider` 数组。** 放弃：与筛选路径「由 rateRows 重建」的口径不同源，两侧形状不同时（缺该维度的旧 rollup）供应商表与顶行失衡，且同一份数据加不加日期筛选会给出两张不同的表。

## Consequences

- 代价：首次 stats 读触发一次 rollup 全量重建（重读全部日文件，几秒级）；同一 day × model × rate 的行再按 provider 分裂，`rateRows` / `bySession` 行数与 rollup 体积增长；旧版宿主 payload 无 `byProvider` / `providerNames`，客户端按空维度与键名兜底。
- 换来：设置面板与大屏两个入口立即可见每供应商的用量（总 tokens · 缓存占比 · 费用）；未标注组在 wire 上显式单列、在列表里以「缺失供应商」弱化行带解释呈现，随时可对账；成本与 byModel 同源，重定价免费；筛选器等下一个消费方直接读现成维度，不再动聚合格式。
- 不变式由测试锁定：每条聚合路径上「各供应商行请求数之和 = 顶行请求数」都成立，合并、筛选与会话维度各有一条断言守着，形状再分叉会被当场抓住。
