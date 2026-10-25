# DR: 用量统计页挂入侧边栏"更多"菜单与主列面板

Status: implemented

## Problem

统计页此前只有设置面板一个入口，层级深；而 dsh 0.2.1-rc.3 为插件开放了左侧栏导航入口定制（`sidebar.panellist.actions`"更多"菜单行 + `main` 主列面板，`main` 本身更早）。直接在侧边栏常驻图标会污染用户的导航列，违背插件"不打扰"的定位。

## Decision

- 通过 `ctx.slots.inject('sidebar.panellist.actions', ...)` 注册一个"Token 用量"菜单行（id `token-usage-more`），点击先 `onDismiss()` 再经 `ctx.layout.selectPanel('token-usage')` 打开主列面板；**不注册 `sidebar.panellist` 图标**，左侧栏只多出区域级的"更多"按钮，用量入口收在菜单里。
- 主列面板注册在 `main` keyed slot（key `token-usage`），复用设置页组件 `TokenUsageSection`：其 `close` 参数可选化，设置面板语义保持"跳转后关闭面板"，主列面板注入 `returnToConversation`（`selectPanel(null)`）作为跳转后的回位动作。组件另加 `variant` prop（`panel` 缺省 / `page`）：主列由 `UsagePanelPage` 提供官方一级页面壳（满高滚动区 + 居中 1200px 柱 + `clamp(24-48px)` 内边距 + 28px 顶距 + darwin 顶栏让位），`page` 变体使用官方标题字级（pageTitle 步 20px/28px/500）。看板与明细沿用[公共组件设计](./2026-10-24-usage-dashboard-isomorphic-board.md)，设置区和主列按各自宽度采用不同密度，不复制统计数据流。
- 布局服务在点击时经 `ctx.get('layout')` 动态解析（同 `configForms` 的模式），不进顶层 `inject`——旧宿主缺该服务时顶层 inject 失败会拖垮整个插件。
- 旧版降级依赖 `ctx.slots.inject` 的等待声明语义：slot 未声明时回调永不执行，注册静默缺席；回调体内的 `register` 再以 try/catch 兜底（同区域同优先级占用等激活期错误不外溢）。菜单行与主列面板要求 dsh ≥ 0.2.1-rc.3，更早宿主维持设置页单入口。
- 设置页统计区保留：旧宿主唯一入口、新宿主双入口并存；devDeps 升至 0.2.1-rc.3，`dsh.client.inject` 补声明 ui-sidebar/ui-layout，peer 放宽为 `^0.2.0-rc.1 || ^0.2.1-rc.1`。

## Alternatives considered

- **注册 `sidebar.panellist` 常驻图标** —— 官方 Plugins/Tasks 的完整模式，但图标常驻导航列，正是要避免的污染；被"更多"菜单行取代。
- **菜单行点击后跳转到设置面板的统计区** —— ui-settings 未提供跨插件"打开面板并定位 section"的导航服务（contract 仅暴露 shell 自用的 `openSettings`），做不到；被独立主列面板取代。
- **顶层 inject 依赖 `layout`** —— 写法更直白，但旧宿主无该服务时插件激活直接失败，放弃。

## Consequences

- 代价：插件类型基线整体抬到 0.2.1-rc.3；新宿主上统计页双入口并存，设置页与主列页的文案与行为需同步维护；菜单行点击依赖布局服务存在（shell 一体声明，实际不可达缺失）。
- 换来：用户侧边栏零新增常驻项；入口两级折叠（"更多"→ 菜单行）；旧宿主完全不受影响。
