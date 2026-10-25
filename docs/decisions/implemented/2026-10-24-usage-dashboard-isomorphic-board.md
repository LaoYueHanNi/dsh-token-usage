# DR: 用量统计大屏化——公共看板与四卡片/四 tab 的同构形态

Status: implemented

## Problem

统计页（设置面板与主列页共用 `TokenUsageSection`）的明细区是三张传统表格（按模型 / 按会话 / 运行开销），大屏页只是把面板布局原样套进 960px 柱，宽屏利用率低；会话表还背着目录分组与三态排序两套交互。demo 三轮迭代定稿了新形态：上方公共看板（指标卡 + 定价状态 + 趋势卡），下方四卡片/四 tab 平铺行式。两处宿主要求"公用设计思路"——同一套组件，两种布局。

## Decision

> [!NOTE]
> 本决策中的性能耗时分母、项目客户端聚合与固定双列布局已于 2026-10-25 由 [DR: 看板性能样本与项目汇总的完整性边界](./2026-10-25-dashboard-aggregation-correctness.md) 取代；其余交互与视觉约定继续生效。
>
> 设置区卡片尺寸和明细布局已于同日由 [DR: 设置统计区保持两行指标与独立紧凑明细](./2026-10-25-settings-compact-dashboard.md) 细化：固定四列两行小卡片，明细使用同栏工具栏和无进度条紧凑列表；page 保持原展示。

- **数据流保持单点**：fetch / `useAsyncResource` / `lastSummary` 保留逻辑 / filters / 定价对话框全部留在 `TokenUsageSection`；新增组件（`OverviewBoard`、`UsageRows`、`OverheadRows`、`DashboardCards`）只收派生 props，loading/error 分支零改动。
- **公共看板 `OverviewBoard`**：8 卡指标行（首卡跨两格的复合卡，label 就是「请求数」——「· 运行开销」后缀被用户否掉，「开销 n」pill 已在卡上承载该信息：`RequestsStatCard` 加可选 props + 中性配色的 `OverheadPill`，hover 出各类次数、page 点击滚动到运行开销卡并闪示、panel 点击切到运行开销 tab）+ PricingStatus + 趋势卡（标题「趋势」，单日窗口恒画当日 24 小时、更宽窗口恒画每日——无「按小时/按日」切换，单一粒度没有可切换的东西）。page 变体以 `size="lg"` 渲染 demo 定稿的 20px 数值 / 12px label / 12·14 padding，compact 面板保持 18px / 11px / 10·12；首卡跨格的 `span 2` 必须落在生成盒子的 wrapper 上——`display: contents` 的 wrapper 不生成盒子，span 无宿主，首卡会退化成单轨宽把 pills 挤成三行（panel 的 compact 网格无 span 才用 contents）。panel 的窄首卡放不下数值行两个 pill，「开销」pill 改挂 label 行（`labelExtra`），否则换行会把整行卡片撑高。pill 落位后仍有两处牵连高度，一并收紧（网格保持 stretch 等高，用户明确要求同行卡高度一致，自然高度参差的 `align-items: start` 被否）：全尺寸 pill（约 20px 盒）比 11px label 的 15px 行盒高、顶起首卡约 6px——label 行内的 pill 收紧到 10px 字/13px 行高/15px 盒；六位计数（「12,263」）加胶囊失败数在约 113px 的卡内容宽里物理放不进一行——失败数在紧凑首卡改**裸红字**（`FailurePill` 的 `bare` 变体：去胶囊 chrome 只留红色 11px 字，hover 分项 tooltip 与键盘焦点保留，与 per-model 表格「紧数字列不上胶囊」的既有处理同语），数值行 `nowrap`（`~` 兄弟选择器限定带 label 行的紧凑首卡，大屏宽卡保持胶囊与可换行）。实测「全部日期」窗口（12,263 + 失败 347 + 开销 224）首卡两行，九卡全部 63px 等高。趋势卡（`TrendChart`）的 viewBox 宽度经 ResizeObserver 实测容器宽 1:1 绘制——原先固定 800×viewBox 等比缩放，1200px 柱下整图放大 1.5 倍（高度与 11px 字号全跟着胀）；实测后高度恒 190px、字号恒定，面板与大屏同一比例。page 指标行以 `.board` 为 inline-size 容器：容器窄于 1180px 时 9 轨降为 5 轨——九个格子（首卡 2 + 单卡 7）恰好两行封顶（用户上限），9 轨在每轨 <100px 时会截断所有 label 并让数值互相重叠。
- **首卡标签口径**：`stat.requests` 文案为「请求数」（不带「成功」前缀）——旁边常驻「失败 {count}」胶囊已表达补集，数字本身含对话、压缩与辅助（运行开销）全部成功调用；「开销」胶囊是其中辅助调用的拆分视图，不是额外的量。
- **平铺行式 `UsageRows`**（kind: project/model/session）：单行式「名称｜相对进度条｜总 token · 缓占比｜费用」，会话行同语法换掉进度条——首行「标题（+徽标）｜总 token · 缓占比｜费用」，副行「目录尾段 · 相对时间」。**三张卡统一为会话行原本的紧凑 figures 语法**：费用格 auto 宽紧随「总 token · 缓占比」数字列（项目/模型曾用 60px 固定费用列，被用户否回——间隔要小），三个列表共用同一 figures 样式。**行内 figures 无任何 hover 弹层**（用户三轮否决：先砍分项费用行，再砍项目/模型行的整个弹层「感觉没必要」，最终会话行也不保留——同格数字已平铺在行内，弹层纯为杂讯；`cost-split.ts` 与 `.tip` CSS 随之删除，连带撤掉为 portal 引入的 `@types/react-dom` devDep）。**进度条按当前排序口径缩放**：token 序时渲染集最高 token = 100%，费用序时最高费用 = 100%，性能视图时最高平均输出速度 = 100%（barMax 跟随当前口径换单位）——条永远不与它所在的行序矛盾。三张卡都有排序控件（`RowSortControl`，受控于 section 的三个独立 state，page 卡头与 panel tab 复用）：项目 token｜费用（默认 token = 折叠序直通），会话 token｜费用｜最近活跃（默认费用 = 服务端序直通），模型 token｜费用（默认 token）。**性能入口是独立开关、不是第三个排序项（用户纠偏：token/费用/最近活跃是排序方式，性能是新的展示，混排产生歧义）**：`PerfToggle`（◷ 仪表符号，`aria-pressed`）立在模型卡卡头排序控件右侧（panel tab 立在 sortRow 同排）——激活后卡内容切为速度行式、计数换「按输出速度」、排序控件**隐位不消失**（`visibility: hidden` 占位防跳动，切回恢复之前的 token/费用选择）；性能视图内无排序控件——它的顺序本身就是定义（有效行按速度降序、低样本/无计时沉底），没有第二种排法。**性能视图（2026-10-25 追加）**：模型卡三个均值指标——输出速度 = `outputTokens ÷ (latencyMs − firstTokenLatencyMs)`、首字 = `firstTokenLatencyMs`、请求耗时 = `latencyMs`，全部取平均、单行紧凑展示（用户否掉 p50/p90 分位数与两行式副行）。落库记录自带 `latencyMs` / `firstTokenLatencyMs`（`usage-record.ts` 的 `RequestTiming`），零新增埋点。**口径防污染**：约 23% 的请求是非流式（生成时长 < 500ms 整包到达），其「速度」高达 23,000 t/s 纯属噪声——只有生成时长 ≥ 500ms 的流式样本进入速度/首字均值（`PERF_STREAM_MIN_GEN_MS`），请求耗时均值取具有有效计时的成功请求（无计时请求不参与性能评价）。**聚合位置**：五个累加器（流式 tps/首字总和与计数、有效请求耗时总和与计数）长在 `UsageTotals` 上（可选键，无 timing 不落键）——它是所有维度共用的折叠单元，rollup 冻结日、`mergeSummaries`、`filterSummary` 的 rateRows 重建全部自动携带，均值在 `attachCosts` 折完 alias 族后一次性派生（`ModelPerf`，从不落盘）；流式样本 < 5（`MIN_PERF_SAMPLES`）的行与无计时行**沉到列表尾部**（组内按名称序）、**不渲染进度条**（名称拉伸占位，也不参与 barMax 缩放），行内灰字只显示速度 + 「样本不足」+ 请求数；每行尾部带窗口内**有效计时请求数**（`ModelPerf.timedRequests`，来自 `perfLatencyCount`；无计时请求不计入）。**旧缓存自动回填（随本功能发版生效）**：rollup 增加 `aggregateFormat` 聚合格式版本（当前 `ROLLUP_AGGREGATE_FORMAT = 3`；性能上线前无此键即 shape 1，缺少有效计时计数的中间格式为 shape 2）——首次 stats 读取发现格式不符时按**定价指纹变更的既有路径**全量重建（从原始 JSONL 天文件重新吸收，原始文件从不删除，token/费用口径有 recovered 校验兜底不变）并把新格式写回，历史时延随之回填；新版本第一次启动即完成，用户无需手动删缓存。实测：重建后四个此前「无计时数据」的模型全部回填（MiniMax-M3 252 tok/s、deepseek-v4.1-flash 238 tok/s、glm-5.3-flashx 160 tok/s、glm-5.3-flash 69 tok/s，与手工从原始文件聚合的数字一致）。列表限高（min 120 / max 400）内部滚动，滚动条静止 800ms 后隐藏。运行开销卡的类别行**默认展开**（collapsedKinds 反转语义，新到类别默认展开，切换 tab 卸载即重置）。
- **按项目维度**：`src/project-rows.ts` 的共享 `projectRowsOf` 在服务端会话列表裁剪前聚合完整根会话集合（同名 cwd 尾段合并、无 cwd 单独一桶、tokens 降序），以 `projectRows` 提供权威项目维度；客户端仅在旧宿主缺少该字段时回退到原折叠。
- **Ctrl 交互迁移**：Ctrl+会话行（虚线暗示）跳转会话页、成功后关面板（原语义原样保留）；Ctrl+模型行把模型过滤**切到该模型**（单选语义：`handleToggleModel` 里同模型再点即清除，过滤后整页只展示该模型）。两处暗示只在 Ctrl 按住时出现，普通点击保持惰性（模型名普通点击仍是定价对话框入口）。
- **variant 分叉**：`panel` → 看板 + 四段 segmented（按项目/按模型/按会话/运行开销，**按项目默认选中**）+ 各 tab 行式；`page` → 看板 + `DashboardCards` 四卡平铺（统计区窄于 960px 时单列）（项目｜会话、模型｜运行开销，无 tab），卡头计数跟随当前排序口径（项目/模型「N 个 · 按总 token／按费用」，会话「共 N 条」，开性能视图时模型改为「N 个 · 按输出速度」），柱宽 960→1200px。`detailMode` 联合加 `'project'` 且默认之（session-local useState，无持久化无迁移）。
- **表格形态退役**：删除 `SessionTable` 三件（目录分组与 tokens 三态排序放弃，`dsh.token-usage.sessionGrouped` localStorage 键成为死键、不清理）；`AuxOverheadSection` 表格形态移除，折叠语义平移进 `OverheadRows`（类别折叠行 + per-model 展开行 + 合计行）。
- **CSS 纪律**：demo 字面色全部改写为 `var(--dsw-alias-*)` + `color-mix`，无新增字面色；卡片列表限高滚动与滚动条隐显在 `UsageRows.module.css` 一处实现，开销卡复用同一滚动容器类。

## Alternatives considered

- **四分项费用平价估算（cost ÷ 4 或 token 占比直乘）**——tooltip 会与行内权威费用打架（四格之和 ≠ 行费用）；先被 `allocateCost` 锚定分摊取代，后整条费用行被用户否掉（「具体费用 hover 没必要」），`cost-split.ts` 随之删除；弹层本身最终整体移除（含最后保留的会话行）——行内 figures 已自足，hover 只剩杂讯。
- **项目/模型行用 60px 固定费用列、会话行用宽间隔**——同页两种 figures 语法读起来割裂，被用户否回（「统一为原来的会话展示，间隔比较小」）；费用格改 auto 宽紧随数字列，三卡共用。
- **性能视图的 p50/p90 分位数口径与两行式布局**——用户两轮否决：分位数对个人使用太学术（「p90 是什么？不需要吧」，定三项均值）；副行（p90 · 端到端 · 样本数）多余（「每个模型性能我也要一行展示」），三项均值一行放完，请求数从行内移除。
- **性能均值只取流式样本**——非流式请求（整包到达）的生成时长趋近零，算出的速度是噪声（实测同一模型均值被污染到 22,992 t/s）；以 500ms 生成时长为流式阈值，速度/首字只统计流式样本，请求耗时不受影响。
- **性能维度绕过 rollup 缓存实时读原始文件**——每次打开页面都要重新解析全部历史 JSONL，与 token/费用维度的缓存策略相悖；被「累加器长在 UsageTotals 上随缓存走 + 旧格式首次读取自动重建」取代。
- **要求用户手动删 rollup.json 回填历史时延**——用户否决（发版后每个用户都要手工操作）；改为 `aggregateFormat` 版本检测下的自动重建，新版本首次启动即回填。
- **进度条恒按 token 口径**——费用排序下条形与行序矛盾（第一名 token 最小却条最短）；barMax 跟随排序 pick 换单位。
- **模型过滤多选化（Ctrl 追加选择）**——与现有 `Filters{model}` 单值契约冲突，且用户明确纠正：Ctrl 是单选切换，过滤后整页只剩该模型，取消筛选才恢复全部。
- **面板与大屏各自实现一套明细**——双份交互逻辑（tooltip/Ctrl/滚动）必然漂移；被同构组件 + variant 分叉取代。
- **保留会话表并挂接新卡片**——两套会话形态并存需同步维护，且目录分组在大屏卡片里没有安放位置；按用户确认的平铺定稿直接退役。

## Consequences

- 代价：`token-usage-section` spec 大规模重写（48 用例中 17 个表格耦合断言改造，列序用例删除）；行 tooltip 的 portal 方案引入过 `@types/react-dom` devDep，随弹层整体移除而撤掉。
- 换来：设置面板与主列大屏读同一套行式与看板（"上方公共看板信息变多 + 下方 tab 展示变为平铺"）；大屏 1200px 柱下四卡等高、内部滚动；会话排序收敛为两态直通语义；运行开销从表格降为行式折叠 + 复合卡一键直达。
