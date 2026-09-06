# DR: rollup 增加会话维度，设置页提供跨会话统计表

Status: implemented

## Problem

设置页的统计目前只有日期和模型两个筛选维度，回答不了"这个月哪个会话花钱最多""哪些会话在烧 token"这类跨会话问题。数据层每条 `UsageRecord` 都带 `sessionId`，但 rollup（`src/rollup.ts`）的行是 (day, model, rate identity) 单元，刻意没有会话维度；会话级查询只能走 `filterRecordsBySessions` 折叠原始记录（`src/stats.ts` 上方注释明言 rollup 无会话维度、整页读取不可复用）。结果：设置页无法按会话筛选或排行，会话级聚合随历史记录数线性增长，且没有聚合层可复用。

## Decision

**数据层**：`RollupFile` 与 `TokenSummary` 新增 `bySession: UsageSessionRow[]` 维度（`src/wire.ts`），行粒度为 **(sessionId, day, model, rate identity)** 单元，另带 `lastTime`（该单元内最新记录时间，折叠取 max）。四个粒度成分各有必要：

- `day`——会话常跨天，日期筛选下会话行的数字必须只含窗口内部分；
- `model`——模型筛选同理，且与 `filterSummary` 从 rateRows 重聚合的既有模式一致；
- `rate identity`——费用聚合必须从带规则身份的单元出发（`attachCosts` 现状），价格表更新后历史免费重定价；
- `lastTime`——会话表按"最近活跃"排序展示。

失效记录（`model === ''` 的 failure 行）拥有自己的 (sessionId, day, model='', rate=UNPRICED) 会话单元——与 rateRows 同一粒度语义（不在行粒度上排除 model=''），不并入有模型的单元，保证请求数对账一致。派生路径逐一定点扩展：`summarizeRecords` 折出 bySession；`mergeSummaries` 按 (sessionId, day, model, rate) 键折叠它（lastTime 取 max，对缺失维度的内存形状宽容 `?? []`）；`filterSummary` 从它按窗口/模型过滤重聚合（与 rateRows 同模式）；`attachCosts` 从同一单元计费出 `CostedSessionCell`（`CostedSummary.bySession`）——费用对账因此免费成立。

设置页的按模型表升级为**可切换的明细表区块**（`src/client/TokenUsageSection.tsx`）：区块顶部一个切换器（按模型 / 按会话）——选中的段即下方表的名字，不另设标题——默认按模型，外观与行为不变；切到按会话时渲染 `SessionTable`，列：会话（标题为主标识，不分组时目录尾段为辅标识）、成功/失败、总 token、费用、最近活跃，后三列的表头可点击排序（首点降序、再点升序、三点恢复服务端默认序，`aria-sort` 标注）。两份行集来自同一次 summary 响应，切换与排序都是纯前端呈现状态（会话内有效，不持久化，与 UsageView 的 scope 开关同一取舍），不多发请求。

会话表的行**固定为折叠视图**（`buildSessionRows`）：行 = 顶层会话，行数字 = 该会话及其全部后代在当前筛选下的用量之和，`childCount` 徽标（"含 N 个子会话"）是子代理在表中的唯一可见性——单个子代理的明细由会话页 Usage 标签页的子代理表承接（可逐层钻取），设置页不提供平铺行集。折叠规则：沿 `parentSession` 链向上走到最顶层根；父会话不在筛选后行集（无用量）的孤儿按顶层处理；亲缘成环时防御性截断按顶层算——规则全部朝"求和不变"收敛。折叠改变行排名（父行按子树总费用排序），top-N 截断（`SESSION_ROW_LIMIT = 20`）必须发生在折叠之后且由服务端完成——折叠不是查询参数，行集只有一种形态，切换任何呈现开关都不重发请求。会话行默认无点击行为（与按模型表一致）。

会话表支持**按工作区目录分组**（`src/client/SessionTable.tsx`）：目录尾段组头 + 组内行，组内行标题相对组头缩进（分组模式的层级线索），无 cwd 的会话归入"未指定目录"组（排在最后），分组状态下目录辅助列并入组头。**默认分组**，可切换为不分组列表（纯前端呈现，切换不发请求；会话内有效，不持久化）。不读取也不写宿主设置：插件自持开关，两组呈现互不影响宿主。

**服务端行集**：whole 载荷新增 `sessionRows`——服务端折叠、按费用降序（并列按 lastTime 降序、sessionId 升序）、截断 top-N 后的最终行，行内自带 title/cwd/徽标/firstTime/lastTime；细粒度 `bySession` 单元不跨越 wire（payload 中剥离），避免把同一份折叠在传输上重复一遍。

**兼容**：旧 rollup 缺 `bySession` 字段 → `isRollupFile` 校验失败（硬性要求，非可选字段）→ 视为缺失、从日文件一次性重建（现有鲁棒路径，record-cache 缓解 IO）。不做可选字段惰性迁移——已吸收的冻结日文件不会重读，无法补出会话维度，硬性失效重建是唯一诚实路径。

**会话元数据索引**：sessionId 对用户几乎不可读，会话表以标题为主标识、所属项目目录为辅标识。索引为数据目录下的 `sessions.json`（`src/session-meta.ts`）：sessionId → `{ title?, cwd?, origin?, parentSession? }`（非默认字段缺失即省略）：

- **标题**来自日志背书的 latest-wins `session/title` 事件。折叠由插件本地实现（`titleOfEvent`，sync/live 共用）：取最后一个 title 事件的文本，宽容归一化（非字符串标题跳过），不为此引入 `@deepseek-ai/dsh-session-title` 新依赖——payload 按鸭子类型宽容读取，本项目用不到其 snapshot 的 seq/来源字段；
- **目录与子代理亲缘**来自 `SessionHeader` 的 `cwd?` / `origin?` / `parentSession?`（宿主创建会话时已持久化），`inspect()` 返回的 `SessionInspection.meta` 与 live 回调入参的 `session.header` 都已在依赖清单的 `dsh-session` / `dsh-session-persistence` 类型内，零新增依赖；
- **live**：现有 `ctx.on('session/event')` 监听里捕获 `session/title` 事件，latest-wins 更新标题（谁 seq 大谁生效，一条分支覆盖改名/自动生成/fallback 全部时机）；header 元数据按会话首次见到时 upsert 一次（header 不可变，无需逐事件重写）；
- **历史回填**：`syncHistory` 逐事件遍历每个会话日志时顺手折出标题，并从 `inspect()` 的 header 读取 cwd 与亲缘并入索引（`SyncDeps.meta` 可选 sink，每会话一次 upsert）——已安装用户的老会话元数据随一次全量同步补齐。`SyncPersistence.inspect` 的返回契约从 `{ events }` 扩至 `{ meta?, events }`（宿主本来就返回 header，只是现实现未取）；手动"重新扫描"（full-sync）同样传入 sink，自动获得元数据修复能力；
- **标记**：`state.json`（`src/sync-state.ts`）加可选字段 `metaSyncedAt`——缺失即未补齐，`autoSyncIfNeeded` 沿用"缺失/畸形读作未完成、重跑幂等、原子写"的既有语义再跑一次同步（用量行被 requestId 去重全部跳过，零写入）；新安装的首次自动同步两个标记一起写入；
- **韧性**：索引是从会话日志可完整重建的派生缓存，损坏即视为缺失（空索引），靠手动/自动全量同步重建，不做增量修补。写入经单写队列串行化（防并发 upsert 互相踩踏）并沿用 temp+rename 原子写；upsert 值无变化时不重写文件（幂等）；写失败不中断队列也不上抛至无人接住：sync 路径的 rejection 由调用方捕获记日志，live 路径 fire-and-forget 自带 `.catch` 记 warn——写失败只降级为标识过期（索引可从日志重建），绝不带崩宿主进程；
- **服务**：路由经 per-directory 的 `SessionMetaStore`（mtime 戳缓存）读索引，元数据由服务端并入会话表行内——行是服务端折叠、排序、截断后的最终结果，行内自带标识最直接，也免去客户端二次拼装；会话页 Usage 标签页的 `chip` / `session` 分层 payload 不受影响；
- **回退**：无标题事件的会话（部分子代理、老数据）显示 sessionId 短形式 + 起止时间，不臆造标题；header 无 cwd 的会话省略目录标识，留空即可。

**迁移**：`sessions.json` 列入 `migrate.ts` 的 OWNED_PATTERNS，随数据目录搬迁整体移动，无需迁移逻辑。

## Alternatives considered

- **不改格式，设置页每次从 `readCachedRecords` 现折叠会话表** —— 零格式变更、零迁移，且冻结记录本就常驻内存，10 万条记录折叠约几十毫秒，短期完全可用。但整页读取语义反转（现有注释明言 settings 页 whole-log read 不折叠 raw），每次筛选变更 O(records) 且随历史无上限增长；今日热文件本来就要现折叠，冻结部分却放着现成聚合层不用。输了：把已知会线性恶化的路径当成正式方案。
- **独立会话用量聚合文件（sessions.json 之类），与 rollup 平行惰性吸收** —— 指把 token 聚合搬出 rollup 的方案：需要多一套吸收/原子写/派生态失效逻辑（`invalidateDerivedState` 多删一个文件），换来的仅是 rollup 文件不变大。输了：两套机制维护成本大于一份变大的 JSON。（本 DR 最终新建的 `sessions.json` 存的是会话标题元数据——可从日志重建的缓存，不是用量聚合，性质不同，不与此冲突。）
- **rollup 只存 (sessionId → totals) 汇总** —— 行数最少，但跨天会话在日期筛选下数字错误（会话总量 ≠ 窗口内分量），模型筛选同样失真。输了：筛选正确性是硬需求，错误的聚合比没有聚合更糟。
- **rateRows 直接加 sessionId 进键** —— 信息等价于新维度，但会把无会话需求的既有读取路径（整页汇总、模型表）也背上会话基数，且破坏 rateRows 的语义稳定性。输了：加法式新增 `bySession` 让现有字段与路径零改动。
- **标题从客户端会话树 store 取（`useSessions` 的 displayTitle）** —— 只覆盖客户端 mirror 已加载的会话，且设置页上下文不保证有该 store 可用。输了：插件自持索引对任意历史会话都成立，且不依赖宿主 UI 内部形态。
- **标题在响应时按需 `persistence.inspect` 会话日志** —— 每次统计请求 N 次会话日志 IO，把成本放在最热的读路径上。输了：索引把成本移到写路径与一次性同步，读路径零额外 IO。
- **标题写进 UsageRecord** —— 标题随时间变化（latest-wins）且与单条请求无关，污染记录语义、逐行放大 JSONL 文件。输了：会话级属性进会话级索引。
- **会话表仅平铺（不做折叠）** —— 实现最省，但重度子代理用户的表被大量短会话行淹没，"哪个会话烧钱最多"只能人工归并。输了：UsageView 已用 scope 开关解决过同一问题，模式现成，折叠只是响应时的一次单元归并。
- **折叠/平铺双模式作用域切换（初版方案，`sessionScope` 查询参数）** —— 实现后实际使用发现：折叠 + "含 N 个子会话"徽标已回答"哪个会话烧钱最多"，单个子代理的明细会话页 Usage 标签页的子代理表（可钻取）本来就有，平铺行集是同一问题的第二个入口；两组开关四个按钮让明细表区块的控件比表格还显眼，作用域参数还带来"切换重发请求"的额外机制与第二种行集形态的维护。输了：可见性有徽标与会话页兜底，双模式没有独立价值——上线当期内即裁撤为固定折叠。
- **客户端折叠（服务端发平铺全量行 + 亲缘映射）** —— 切换排序/作用域不发请求，但折叠改变行排名，正确的 top-N 截断要求把全部行发给客户端，传输量随会话数无界。输了：服务端折叠把传输量钉在前 N 行（客户端的列排序只在已收到的行内重排，纯呈现）。
- **引入 `@deepseek-ai/dsh-session-title` 依赖做标题折叠** —— 官方 fold 保证语义跟随宿主演进，但本插件只需要 latest-wins 的标题文本，为此新增一个与宿主版本线独立演进的依赖（0.1.0-rc.x）不值；该项目连 type-only import 的官方包都声明依赖，引入即有安装与对齐成本。输了：几行本地宽容折叠已覆盖所需。
- **把插件的分组偏好写进宿主设置节（跟随并联动宿主）** —— 越权写其他节，且直接改变宿主侧栏行为。输了：分组是插件自己的呈现开关，两组呈现都不该碰宿主。
- **读取宿主侧栏"列表/分组"偏好作为默认值** —— 跟随最"像宿主"，但该偏好在本插件可见的依赖面内没有已发布读取口（侧栏属宿主未随插件安装的 UI 包），为此依赖宿主内部形态（或等待其暴露 API）不值。输了：默认分组已贴合宿主观感，成本为零且不引入任何耦合。

## Consequences

**所得**：设置页能按会话回答"哪个会话花钱最多"并做模型×会话交叉分析（模型筛选不豁免会话行，语义自然变为"该模型被哪些会话消耗"）；日期/模型筛选下会话表各列之和与汇总卡对账一致（同一 summary 派生保证，测试钉住求和不变性：孤儿按顶层、嵌套到根、环防御截断、筛选先于折叠），且行集只有折叠一种形态，对账心智模型简单；三列点击排序让"最近活跃/烧钱/token"三种读法零请求切换；费用从同一 rate 单元计费，价格表更新免费重定价历史；聚合层（`buildSessionRows`）可复用，会话级聚合不再随历史记录数线性增长；live 改名即时反映、历史会话经 `metaSyncedAt` 一次性回填补齐。

**代价**：rollup 文件与内存聚合随会话数增长（行数 ≈ 每天 会话×模型×rate 组合数，常规年累计万级行 JSON 可控；重度子代理用户会放大——必要时后续对传输加截断或对超旧会话归档）；升级后首次统计读取触发一次 rollup 全量重建（record-cache 已把冻结文件常驻内存，属一次性成本，重建失败不阻塞读取）；老安装的元数据回填要一次全量遍历（`initialized` 标记保证不会自动重跑，那次遍历的用量行被去重全部跳过）；rollup 与 wire 均为跨版本契约，`bySession` 的硬性校验使所有旧 rollup 在升级后首次读取时失效重建——这是刻意的，不是兼容事故；`sessions.json` 是又一个需要测试覆盖的持久化文件（原子写、损坏重建、幂等 upsert、单写队列），但它损坏的代价只是标识回退，不会丢任何用量数据。
