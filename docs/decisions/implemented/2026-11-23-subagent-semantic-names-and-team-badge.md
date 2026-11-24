# DR: 子会话表展示子代理语义名、外部子代理与团队模式徽章

Status: implemented

## Problem

DSH 0.2.2 起子代理有了**语义名**：父会话日志的 `subagent/catalog` v3 为每个直接子代理记录 `name`（未指定时宿主自动取 `agent-N`），子会话自己的 `subagent/descriptor` 记录委托描述与生命周期模式，根会话的 `team/mode` 记录是否启用智能体团队；另有在别处执行、没有本地会话的**外部子代理**（`mode: 'external'`）。本插件的用量页签「子会话（N）」表对此一无所知：

1. 首列直接取宿主会话镜像的 `displayTitle`（`title ?? label ?? childId`），镜像不携带语义名，用户看到的是一段委托描述，与 `list_agents`、任务板里的名字对不上；
2. 镜像对 `mode === 'external'` 的条目直接跳过，外部子代理在表里整行缺席；
3. 没有任何地方读取 `team/mode`，看不出一个会话的子代理是否互为队友；
4. 插件此前不读这三种事件，`sessions.json` 里没有可下发的身份事实。

设计初稿曾拟定在行首画语义名徽章并按标题优先展示（本地需求稿与效果图未入库，初始确认短码 `1A 2A 3B 4A 5A 6A 7A`）；实机复核后发现老会话截取自提示词开头的默认 `title` 噪音较大，且行内英文代号徽章与中文委托描述信息高度重合、挤占 `250px` 首列宽度，故经用户确认收敛为：**行内只保留简洁的委托描述（缺省时回退到标题、语义名或会话 id），语义名移入悬停第一行（如 `poet · 子会话 <id> · 可持续`）**；团队模式只在区块标题旁放一个徽章；计数把外部子代理算进去；外部子代理列出为弱化、不可钻取的一行。本记录写明这些决定如何落地，以及实现时补做的决定。

## Decision

1. **身份事实摊到各子会话条目上，外部子代理以目录的 `childId` 为键落条目**（[session-meta.ts](../../../src/session-meta.ts)）：
   - `SessionMeta` 新增 `subagentName` / `subagentLabel` / `subagentMode`（`one-shot | continuable | external`）与 `teamMode`；`isMeta` 按类型宽容解析，`teamMode: false` 是有效值而非「未设置」。
   - 外部子代理没有会话、没有 header，它的条目是 `{ parentSession: <列出它的会话>, subagentName?, subagentLabel?, subagentMode: 'external' }`，**不带 `origin`**。[血缘索引](./2026-11-06-server-side-subtree-scope.md) 只收 `origin === 'subagent'` 的条目，所以外部子代理天然不进范围展开、会话表折叠与任何用量统计。
   - `stats.ts` 的 `SessionMetaEntry` 改为 `SessionMeta` 的类型别名，两处原本各写一份的定义不再有漂移的可能。
2. **三种事件只折叠会话的自有事件**（[sync.ts](../../../src/sync.ts)、[index.ts](../../../src/index.ts)）：
   - 与宿主自己的投影逐字对齐——宿主折叠 `subagent/catalog` 与 `team/mode` 时 `event.seq < inheritedEventCount` 即跳过，`subagent/descriptor` 的投影注释也写明只认 `session.isOwnSeq` 的自有后缀。因此 fork 副本继承前缀里的目录条目**既不折叠到副本名下、也不折叠到它列出的子代理名下**：副本并不拥有祖先的子代理，继承来的祖先描述符也不是副本的身份。这是 [Fork 继承前缀口径](./2026-11-22-fork-session-inherited-prefix-dedup.md) 在身份事件上的延伸；与标题不同，继承的身份值一概不借用。
   - 实时路径把折叠放在既有的 `if (!ownEvent) return` 之后，自然继承同一判定；全量同步只在 `ownEvents` 上折叠，身份事件不会触发前缀回读（缺自有标题时的回读仍只为标题，见该决策）。
   - 每种事件的折叠规则照宿主语义：**catalog** 每条一个子代理，同一 `childId` 按字段后到者赢；**descriptor 以首条为准**（宿主 `foldSubagentDescriptor`：后来的同类型事件不能重写已声明的组合）；**team/mode 最新赢**，且只落在写出它的会话（运行时根）上，子代理通过血缘上行读取。载荷的 `version` 不参与判定——字段在就读，未来版本沿用相同字段名时无需改动，不认识的 `mode` 读作「未声明」。
3. **目录优先于描述符，靠弱写做到与遍历顺序无关**：
   - `label` 的来源规则是「父会话目录优先，目录没写再取子会话描述符」。但全量同步遍历会话的顺序由 `list()` 决定、子会话完全可能先于父会话被读到，若描述符也是普通合并，结果就取决于谁先写。
   - 因此描述符走 **fill-only** 合并：只填索引里还没有的字段。`SessionMetaStore.upsert(id, patch, { fillOnly })` 与批量条目的 `fillOnly` 标志都表达这一点；父会话的目录条目是普通合并，随时可以覆盖。两种遍历顺序最终都是目录的说法胜出（测试钉住了两种顺序）。
4. **每个会话一次批量落盘**：`SessionMetaStore.upsertMany(entries)` 在串行队列里做一次读-合并-写，批次内重复的 id 按序合并，全部无变化则不写文件。同步在每个会话的事件循环结束后组装一批（自身的标题 / header / teamMode、描述符弱写、每个目录子条目），`upsert` 委托给 `upsertMany`。`SyncMetaSink.upsertMany` 是可选方法：没有它的 sink 退化为逐条 `upsert`，且 fill-only 标志原样传递——一个父会话几十个子代理不再重写几十次整个索引。只说出 `childId` 而没有任何身份字段的目录条目不落盘（它没有陈述任何事实）。
5. **名单由服务端下发，仅 `fields=session`**（[stats.ts](../../../src/stats.ts)、[stats-route.ts](../../../src/stats-route.ts)、[wire.ts](../../../src/wire.ts)）：`buildSubagentRoster(meta, root)` 产出 `subagents: { teamMode?, children: [{ id, name?, label?, mode?, title? }] }`。
   - `children` 是索引中 `parentSession === root` 且「带 `origin: 'subagent'` 或 `subagentMode === 'external'`」的条目，按索引顺序；只保留了 `parentSession` 的历史普通 fork 不在其中。
   - `teamMode` 取**血缘根**的值：`lineageRootOf` 沿严格血缘（`buildLineageIndex`）上行，`seen` 集合在第一个重复节点处停下，环与自指都不会循环；根未记录过选择时省略该字段，记录为关闭时下发 `false`。
   - 该块只在带 `root` 的 `fields=session` 读上派生：chip、会话范围的 full 读、整表读与旧的显式 id 形式都不带。
6. **页面合并两份来源**（[session-stats.ts](../../../src/client/session-stats.ts)、[UsageView.tsx](../../../src/client/UsageView.tsx)）：
   - **本地行仍只来自镜像**——镜像行是钻取与「返回」的依据；名单只给这些行补 `name` / `label` / `title`，保持镜像顺序。**外部行只来自名单**，排在全部本地行之后，按名单顺序。名单里既非外部、又不在镜像中的条目不成行（归档或已删除的子会话，改动前也从不列出；它们的用量仍按索引血缘计入「含子会话」范围，不丢数）。
   - 说明文字：委托描述 `label` → 镜像 `displayTitle`（不是裸 id 时）→ 镜像 / 索引 `title` → 语义名 `name` → id。0.2.2-rc.3 之前的子会话日志常保留截取自任务提示词开头的默认 `session/title`（甚至 `<system-reminder>` 片段），而父会话 `label` 才是凝练的任务摘要；因此优先展示 `label`，仅在缺少 `label` 的子会话上回退到 `title`、`name` 或裸 id。**悬停**以原生 `title` 承载一行完整身份（`name · 子会话 <id> · 可持续/一次性`，外部行 `name · 外部子代理 <id>`；当 `name === id` 或无 `name` 时不重复拼接），不再附带被跳过的 `title`。
   - 行内不渲染语义名徽章：实机复核显示，英文代号徽章与中文委托描述并排时视觉重复且挤占首列一半宽度；将 `name` 移入悬停既保留了与 `@mention` / 任务板对账的能力，又把完整 `250px` 留给说明文字。外部行是不可点击的弱化行，六个数值列合并成一句「外部执行，不计入本地账本」——一排「—」会被读成「测过，是零」。区块计数等于表内行数（本地 + 外部）。团队徽章只看血缘根的 `teamMode === true`，行内不加任何标记。
7. **样式**（[UsageView.module.css](../../../src/client/UsageView.module.css)）：
   - 首列改用 `.table td.childCell`（上限 250px，提高特异性压过 `.table td` 的默认 `padding: 4px 6px`，保持 `padding-block: 3px` 使 `18px 行盒 + 6px 内边距 + 1px 折叠边框 <= 26px`），表头 `.subagentsWrap .table th` 同取 `18px` 行高与 `3px` 垂直内边距并锁定 `26px` 高度；按模型表的 `.modelCell` 仍是 180px；放不下时说明文字单行省略。

## Alternatives considered

- **把宿主依赖升到 0.2.2，直接消费宿主的 `subagentCatalog` 投影与类型** —— 放弃：路线图要求基线保持 `0.2.1-rc.3`；而且即便升级也解决不了问题——会话镜像不携带 `name`，并直接跳过外部子代理，外部行无论如何都得由本插件自己下发。
- **在父会话条目里存一份目录数组（`subagents: [...]`），而不是把身份摊到各子会话条目** —— 放弃：读取端还要把数组与各子会话条目再做一次 join；实时路径每来一条目录事件都要读出整个数组、改一个元素、整体写回，并发写的冲突面更大。摊到子会话条目后每次写只碰一个键，重复到达天然幂等。
- **外部子代理条目也写上 `origin: 'subagent'` 以复用现成的血缘逻辑** —— 放弃：它会被 `buildLineageIndex` / `resolveSessionScope` / `buildSessionRows` 当成真子会话，一个没有会话的东西却进了范围与折叠；不带 `origin`、用名单单独识别才是诚实的。
- **描述符也做普通合并，靠「先父后子」的遍历顺序保证目录优先** —— 放弃：同步遍历顺序由 `list()` 决定，没有任何保证；结果取决于顺序的合并在下一次全量同步时就会翻转。fill-only 弱写才是顺序无关的。
- **`SyncMetaSink` 强制要求 `upsertMany`，删掉逐条接口** —— 放弃：逐条 `upsert` 是实时路径（每个事件一次小写）与既有测试替身的全部所需；可选的批量方法加退化路径既放宽了接口，又不改任何既有调用方。
- **说明文字与悬停一律以 `sessions.json` 为准，不读镜像 `displayTitle`** —— 放弃：当子会话没有 `label` 时，镜像 `displayTitle` 仍是获取标题与手动改名结果的直接来源，作为 `label` 之后的兜底保留。
- **在行首常驻等宽语义名徽章** —— 实机复核后放弃：在「智能体团队协作」等场景中，主代理通常把 `name` 起为英文代号（如 `poet`）、把 `label` 写为中文描述（如 `写一首古诗`），两者并排显得同义重复且挤占 `250px` 首列近半宽度；将 `name` 移入悬停提示保留了跨界面对账能力，同时保持列表行清爽。
- **名单里「非外部但不在镜像」的条目也列出，做成不可钻取的行** —— 放弃：没有镜像行就无处钻取、无法返回，会出现一种设计没有覆盖的「本地却不可点」的行；改动前这些行也从不出现，保持现状是更小的行为改变。
- **悬停提示用宿主的 Tooltip 组件气泡** —— 放弃：子会话表行高 26px、限高 15 行，气泡会盖住相邻行，客户端测试还得替身掉该组件；原生 `title` 足以承载语义名、会话 id 与模式。

## Consequences

- 代价：`sessions.json` 的每个子会话条目至多多出三个字段，根会话条目多一个布尔；`fields=session` 的响应多一块名单，体积随直接子代理数线性增长（每条仅几十字节，不受请求头上限约束）。已有数据目录需在设置页手动「全量扫描同步」一次，既有子代理才补上身份信息；升级到 0.2.2 之前创建的子代理日志里没有 `name` 与 `mode`。外部子代理没有本地用量，它出现在表里却不改变任何数字。
- 换来：子会话表行内只呈现凝练的委托描述（不再被截断的任务提示词标题或同义英文徽章挤占），悬停即可核对语义名、子会话 id 与生命周期模式；外部子代理第一次在表里可见，并说明自己为什么没有数字；根会话启用智能体团队时一眼可辨；表头与数据行双双锁定 `26px`。实时与全量两条链路、任意遍历顺序、fork 副本之下，落盘结果一致。`pnpm typecheck` 通过，`pnpm test` 63 文件 / 1353 用例全绿，覆盖：三种事件的折叠（v0–v2 无 name、首条描述符为准、目录字段级后到者赢、无效载荷、两种句柄下的继承前缀不折叠）、批量落盘与 fill-only、名单派生与找根（含环、自指、根缺失）、路由仅 `session` 读下发、页面渲染（纯委托描述行、外部行、计数、团队徽章、悬停含语义名、旧宿主回退）与实时路径端到端。
