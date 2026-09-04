# DR: 用量 tab 走宿主 composer overlay，屏蔽对话列宽度手柄

Status: implemented

## Problem

dsh 0.1.2 给对话 tab 加了左右拉宽度手柄（`ConversationRoot` 的 `[data-width-handle]`，写 `--dsh-chat-user-width`）。手柄挂在会话列骨架上，不按当前 view tab 过滤；用量 tab 是全宽仪表盘，手柄会叠在图表/卡片上可拖。原生轨迹 tab 没有这根条。

## Decision

用量根节点声明宿主契约 `data-conversation-composer-overlay`（与 `ui-trajectory` 的 `TrajectoryView` 相同）。`ConversationRoot.module.css` 用 `.root:has([data-conversation-composer-overlay]) .widthHandle { display: none }` 藏手柄；同一选择器把滚动交给 view 自己的 scroller，composer 改为绝对浮层。用量 CSS 用 `--dsh-composer-height` 预留下边距，避免最后一条被输入条盖住。加载/失败/就绪三个根都带该属性，切到用量 tab 立刻生效。

## Alternatives considered

- **插件 CSS 全局 `display:none` 掉 `[data-width-handle]`** —— 模块随 client bundle 常驻，选择器一旦不带 `:has(用量根)` 就会在对话 tab 也藏手柄；即便写对，也绕开宿主已公开的 overlay 契约。否决。
- **只藏手柄、不声明 overlay** —— 宿主没有单独的 hide-handle 属性；手柄命中区仍会盖住仪表盘。否决：轨迹的屏蔽就是 overlay 这一条分支。
- **改宿主按 view id 过滤手柄** —— 插件仓库改不了 `ui-conversation`；就算能改，用量仍需要 full-bleed scroller。否决。

## Consequences

- 所得：用量 tab 与轨迹一样没有宽度手柄；仪表盘继续用自己的 `overflow-y: auto`。
- 代价：用量 tab 上 composer 变成浮层（与轨迹相同），不再占用对话列滚动流。对话 tab 的手柄与宽度偏好不受影响。
