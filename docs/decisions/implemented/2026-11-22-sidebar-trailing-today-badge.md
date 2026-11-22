# DR: 侧栏入口尾部展示今日总费用与总 Token

Status: implemented

## Problem

路线图第 7 点要在左侧栏「Token 用量」常驻入口行的尾部直接显示今日消耗。上游 ui-sidebar 在 master（`48c65b38675`，`SidebarRoot` / `sidebar.panellist.trailing`）新增了行内尾部槽位，但本插件当前面对的宿主分两类：

1. `0.2.1-rc.3` / `0.2.2-rc.5` 的 ui-sidebar 从未声明该槽位（npm 包与桌面 runtime 均无），插件必须静默降级，不能因注册失败影响现有入口；
2. 插件的编译基线仍是 `0.2.1-rc.3`，其 `SlotMap` 里没有该键，直接注册会编译失败。

同时，现有 `/token-usage/stats` 对 whole-scope 读取无论 `fields` 为何都返回完整聚合（`byDay` / `byModel` / `bySession` / `pricing` 等），不适合作为入口行每秒都在看的轻量轮询；而 `readFilters` 已支持 `from` / `to`，缺的只是客户端编码与一个精简响应分支。

用户明确要求的是「今天全部会话加起来的**总 Token + 总费用**」，不是单会话、也不是历史累计。

## Decision

1. **注册 `sidebar.panellist.trailing`，id 与面板对齐**：[client/index.ts](../../../src/client/index.ts) 以 `id: 'token-usage'`、`order: 50` 注册 [SidebarTrailing.tsx](../../../src/client/SidebarTrailing.tsx)。槽位由宿主按面板 id 匹配，展开态渲染在标题之后、unpin 按钮之前，折叠态落在图标右上角。注册独立于 `sidebarPinned` 设置：行不存在时宿主不渲染，行存在时尾标自然出现。旧宿主没有该槽位声明 → `ctx.slots.inject` 回调不运行，入口保持原样。
2. **编译期契约在插件内补齐**：[client/index.ts](../../../src/client/index.ts) 的 SlotMap 增强里声明该槽位（`kind: 'list'`、`scope: 'root'`、`inline: true`、owner `{ wide, active }`），字段与上游一致；升级依赖基线到声明该槽位的版本后删除该块即可，避免重复声明冲突。
3. **今日口径走现有 stats 路由的 `from` / `to` + 精简 chip**：
   - [wire.ts](../../../src/wire.ts) 的 `encodeStatsQuery` 增加 `from` / `to`（`YYYY-MM-DD`）编码；
   - [stats-route.ts](../../../src/stats-route.ts) 对 **whole-scope + `fields=chip`** 返回 `WholeChipSummary`（`total` / `totalCost` / `costState` / `unpricedModels` / `currency` / `usdExchangeRate` / `feedVersion`），不再下发 `byDay` / `byModel` / `bySession` / `pricing` / `sessionRows`；`from` / `to` 在 `filterSummary` 阶段生效，今日边界取本地日键；
   - 组件每次拉取 `${STATS_PATH}?from=<今天>&to=<今天>&fields=chip`，与用量页同源同口径。
4. **展示与刷新**：[SidebarTrailing.tsx](../../../src/client/SidebarTrailing.tsx) 展开态显示 `费用 · Token`（沿用 `formatCost` / `formatTokens`，如 `12.40￥ · 1.2M`），费用不可定价时显示 `—` 而保留 Token；折叠态只保留费用短格式（如 `12￥`），因为 rail 只给角标几个像素。刷新为挂载即读 + 60s 轮询 + 页面重新可见时补拉；首读失败 15s 后重试，后续失败保留上一次渲染；今日无请求时整段不渲染。
5. **无障碍与交互边界**：内容渲染在行按钮内部，因此保持纯展示（无按钮/链接），分隔符 `aria-hidden`，数字文本进入按钮的可访问名；不改变原生 unpin / 面板打开行为。

## Alternatives considered

- **新增专用 `/token-usage/today` 路由** —— 放弃：`/token-usage/stats` 的 `from` / `to` 已经能表达「今天」，新增路由会多一份 HTTP 契约、鉴权与测试；把 whole-scope `chip` 精简成总量即可，客户端只多一个查询参数。
- **客户端拉 whole-scope 全量 summary 后自行取今日** —— 放弃：每次轮询携带 `byModel` / `bySession` / `pricing` 等无关层，入口行的刷新不该有这种带宽；同时会把「今日」聚合责任复制到客户端。
- **在不支持该槽位的 0.2.1/0.2.2 宿主上用图标角标自绘数字** —— 放弃：那会改宿主行的图标内容与视觉层级，且与未来升级后的行尾布局冲突；当前选择静默降级，能力随宿主升级自然出现。
- **折叠态同时显示费用与 Token** —— 放弃：rail 的角标只有几个像素，两个数字必然互相压盖；保留费用作为主指标，Token 在展开态可见。

## Consequences

- 代价：桌面端 `0.2.2-rc.5` 没有该槽位，本次实现要等宿主升级到声明它的版本（master / 0.2.3-alpha.2+）才可见；在旧宿主上功能完全静默，无法通过插件侧绕过。每次刷新仍会走 `buildSummary` 的缓存聚合（与用量页同一条读路径），只是响应体被裁到总量；折叠态牺牲了 Token 数字。
- 换来：入口行常驻「今日总费用 + 总 Token」，无需切到用量页；口径与用量页今日一致；对旧宿主零影响、零报错；类型层不依赖未发布的上游声明，升级后删掉增强块即可。