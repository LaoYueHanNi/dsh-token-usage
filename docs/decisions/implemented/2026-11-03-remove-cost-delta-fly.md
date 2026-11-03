# DR: 移除 +Δ 飞字，费用动效只留数字弹跳

Status: implemented

## Problem

`+Δ` 飞字（绝对定位在胶囊之下、WAAPI 下落）是费用动效的一半，也是唯一会把 composer 顶飞的一半。

composer 的 seat 是 `position: sticky; bottom: 0`，宿主把 composer 钉在窗口底边；向下画的标签离开 composer 的盒子，落进对话滚动容器 `[data-conversation-scroll]` 的可滚动溢出区（飞字盒底在 composer 底边以下约 40–55px）。宿主跟随尾部驱动按 `content = scrollHeight - spacerHeight()` 算真实内容高度，只扣 turn spacer 不扣飞字 → 滚动位置被推过内容末尾 E 像素；滚到底时 seat 的静态底边正好等于视口底边（sticky 没有余量可吸收），sticky 又只会往上拉、绝不往下推 → 胶囊 + 输入框整体上浮，底部留出空隙。思考中与多轮请求每次费用上涨都生成一枚飞字，问题反复出现；WAAPI 末帧的 `fill: 'both'` 把 `opacity: 0` 的盒子一直留着，所以看不见的飞字照样顶飞输入区。

方向的历史：这套动效最初长在右上角的 `SessionStatsChip` 上，方向本来就是**向上**（chip 时代提交 `2da375d` 记为"`+Δ` 上飘标签"）；2026-09-25 迁入 composer 下方 dock 时改成向下，理由是"dock 位于 composer 之下，原向上飞行会窜入消息滚动区"——这条理由对 dock 不成立（向上只会压在输入卡片上，不在消息滚动区内）。

向下还有一个先天问题：composer 永远贴着窗口底边，向下飞的标签本来就出屏不可见——它唯一能被看见的时刻，恰好就是这个 bug 露出的那条缝。也就是说这枚标签**常年不可见，却常年把输入区顶飞**。

## Decision

**整条 `+Δ` 飞字链路移除，费用动效只保留数字自身的 `costPop`**：

- 删除 `CostDeltaFlyLabel` 组件、`.deltaLayer` / `.deltaFly` 样式、`runDeltaFly` 运动函数，以及 `useCostInflate` 里生成与卸载飞字的状态、计时器与 `flyY` / `flyX` 参数。
- `costPop` 原样保留：按请求 token 增量算强度 `I = 0.55·缓存未命中率 + 0.45·输出量`，映射数字的缩放峰值（1.08–1.32）、warn 染色（0–55%）与时长（1000–1800ms）；reduced-motion 下静默更新数字。
- `costPop` 的缩放只作用于数字 span 的 `transform`：数字绘制盒最高 26.4px，胶囊下沿距 seat 底边 4px，溢出仍落在 composer 的 seat 盒内（距底边约 1.8px），对滚动容器的可滚动溢出区零贡献。

## Alternatives considered

- **改成向上飘** —— 整条轨迹落在 composer 的 seat 盒内，确实也零溢出；但标签会压在输入卡片下沿，且它承载的信息量有限（真正的分摊与增量解释在点开的明细面板里）。输。
- **保留向下，改用 portal + `position: fixed` 画到 `document.body`** —— 能让标签脱离滚动容器的溢出区，但向下飞的标签仍然出屏不可见，等于修好了一个看不见的东西。输。
- **在宿主侧修**（把 seat 的 sticky 改成绝对定位，或让 seat 底边为溢出留余量）—— 插件仓库改不了宿主包；宿主自身的 dock 项都不产生溢出，问题只出在插件多画的那一枚标签。输。
- **让标签在胶囊行内水平漂移** —— dock 行只有 22px 高，水平漂移要么压到右侧的上下文计量条，要么超出容器右缘触发横向滚动条（`overflow-y: auto` 会把 `overflow-x` 计算成 `auto`）。输。

## Consequences

- 换来：composer 永不被费用动效顶飞；费用动效只剩数字自身的一次缩放加染色，语义单一、零溢出、零覆盖；代码面少掉一个组件、一段样式、一个运动函数与一整套计时器状态。
- 代价：看不到"本次请求花了多少"的即时数字（总额与分摊需点开面板）；强度映射只剩 `costPop` 一路（`flyY` / `flyX` 随飞字一并删除）。
- 兼容：`fields=chip` / `fields=session` wire 形状、宿主路由、slot 注册全部不变。
