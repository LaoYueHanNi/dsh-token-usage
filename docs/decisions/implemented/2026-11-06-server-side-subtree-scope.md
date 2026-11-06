# DR: 会话用量范围改由服务端按血缘展开，请求只带 root + scope

Status: implemented

## Problem

用量视图的「本会话 / 含子会话」与 composer dock 费用胶囊此前把整棵子会话子树枚举成重复 `sessionId=` 参数，子会话表还要再用 `childId=` 把整棵树列第二遍。会话「为白云对接群并发建立话题索引」扇出 158+ 个子智能体时，用量页请求 URL 达到约 17.7 KiB，超过 Node HTTP 服务默认 `maxHeaderSize = 16 KiB`，llhttp 在解析阶段直接回 `431 Request Header Fields Too Large`，请求根本进不了 `/token-usage/stats` 的 handler：页面显示「统计加载失败：HTTP 431」，并随兜底轮询每 5 秒重发同一个失败请求。

本机实测（同一服务、真实会话 id）：`?sessionId=<root>&fields=chip` 107 B → 200；`treeRes` 形态（全部 `sessionId`、无 `childId`）9,084 B → 200；用量页形态（`sessionId` + `childId`）17,682 B → 431。所以元凶是 `childGroups` 把 id 列第二遍，而费用胶囊恰好不带它，一直正常。只把 `childGroups` 服务端化能把 URL 减半、修好当前规模，但 `sessionId` 列表仍是 O(n)，子会话约翻一倍（约 310 个）就会以同样方式复发 —— 不是根治。

## Decision

统计请求改为**表达范围规则，不枚举集合**：`?root=<sessionId>&scope=self|subtree&fields=...`，`scope=self` 为默认、可省略。浏览器端 `UsageView` 与 `CostPill` 的三处读取全部改用该形式；`requestKey` / `scopeKey` 改为常量长度的 root + scope + freshness，不再把上百个 id 拼成约 17 KiB 的内存字符串。

- `wire.ts` 新增 `StatsScope` / `ROOT_PARAM` / `SCOPE_PARAM` / `decodeStatsScope`；`encodeStatsQuery` 在带 `root` 时忽略 legacy id 列表，两种形式互斥。
- `stats.ts` 新增 `buildLineageIndex` / `resolveSessionScope`：从 [会话元数据索引](./2026-09-05-session-dimension-rollup.md) 的 `parentSession` 建 parent → children 索引，深度优先展开子树（`seen` 防环），并按「直接子 + 其后代」派生 `childGroups`。`buildSessionRows` 复用同一个 `buildLineageIndex`，保证会话表折叠与范围展开口径一致。
- `stats-route.ts` 把元数据读取提前为每请求一次（store 有 mtime 缓存），收到 `root` 时用 `resolveSessionScope` 覆盖 `sessionIds` / `childGroups`；`childGroups` 仅在 `fields=session`（用量页）时派生，chip / detail 读不付这个成本。root 无已知血缘时退化为只统计 root 自己，不报错。
- `childBreakdown` 由「每组一次全量过滤」改为一次遍历按组分桶，避免 200 个直接子会话时重扫日志 200 次（这条路径过去被 431 挡住，从未真正跑到过）。
- **legacy `sessionId` / `childId` 参数保留为服务端兼容层**（旧前端 bundle、手写 URL、现有测试），但浏览器端不再产生；后续版本可移除。
- 前端范围快照、防抖与串行轮询语义不变，见 [DR: 会话请求池](./2026-10-25-session-request-pool.md)；费用胶囊的懒加载分层不变，见 [DR: composer dock 费用胶囊](./2026-09-25-usage-pill-in-composer-dock.md)。

## Alternatives considered

- **只把 `childGroups` 服务端化** —— URL 从 17.7 KiB 降到 9 KiB、能修好当前 158 个的 431，但 `sessionId` 仍随子会话数线性增长，约 310 个就会复发；用户明确要求根治。否决。
- **POST + JSON body 承载 id 列表** —— 彻底避开 `maxHeaderSize`，改动最小且保留前端运行时镜像作为权威口径；但仍是 O(n)，且要把 GET 改成 POST、读 body、补 same-origin / 幂等语义，属于止血而非根治。否决。
- **把血缘写进每条 usage 记录（`rootSessionId`）** —— 终局方案：请求 O(1)、口径与记录同源、不依赖元数据时效；但要改磁盘格式、回填历史 JSONL、加迁移兼容，成本远高于本次故障范围。保留为未来演进方向，本轮不做。
- **压缩 id（逗号合并 / 短序号字典）** —— 只降低常数，仍是 O(n)，且引入字典同步复杂度。否决。
- **前端分批请求再合并** —— 绕开限制而非根治，N 次请求都要读全量日志，且某一批仍可能 431。否决。
- **调大宿主 `maxHeaderSize`** —— 不在插件能力内，且只是把阈值后移。否决。
- **完全删除 legacy 参数** —— 旧版前端连新版 host 会静默退化，且现有 27 处测试断言全部失效；保留兼容层成本更低。否决。

## Consequences

- 换来：请求 URL 恒定（实测 < 80 字节），与子树规模无关，158 个甚至上千个子会话都不会再触发 431；子会话表 `children` 由服务端按同源血缘派生，口径与会话表折叠一致；前端不再构造 17 KiB 的 debounce key；`childBreakdown` 在大规模子树下只扫一次日志。`pnpm typecheck` 通过，`pnpm test` 60 文件 / 1191 用例全绿，新增 `tests/scope-resolution.spec.ts` 与 200 子会话、fallback 的端到端用例。
- 代价：范围口径以落盘的 `sessions.json` 血缘为准，刚派生、header 尚未落盘的子会话可能暂不计入；顶部卡片的 TTFT / 吞吐仍用运行时镜像，子会话表的这两项已改由服务端记录派生（见 [DR: 子会话计时改由服务端记录派生，并去掉挂载时的重复统计请求](./2026-11-06-subagent-timing-and-initial-fetch-dedup.md)），两者口径边界在此明确记录且未强行统一。`fields=session` 的响应会随直接子会话数增长（响应体不受 `maxHeaderSize` 限制，行数上限沿用 [子会话表限高](./2026-11-05-subagent-table-row-cap.md) 的 UI 处理）。服务端多一次内存 Map 展开与分桶；wire 上并存新旧两套契约，需在未来版本移除 legacy。
