# DR: 趋势图 X 轴刻度按坐标与标签宽判重，替代按索引中点取样

Status: implemented

## Problem

会话趋势图在 `temporal` 模式下按真实时间跨度线性映射各请求桶的横坐标 `xs`。当请求在时间上高度偏斜（例如前一天集中请求、隔夜空白、次日零星收尾）时，点数组的中位下标 `Math.floor((length - 1) / 2)` 仍落在密集一侧，与起点或终点相邻仅数像素；原有 `labelIndices(length)` 无视横坐标和文本宽度直接渲染 `[0, middle, last]`，导致两个长日期时间标签重叠遮挡。点数 `≤ 3` 时同理会在窄画布或紧邻时间下碰撞。

## Decision

1. 将 [scale.ts](../../../src/client/trend-chart/scale.ts) 中的 `labelIndices(xs, labels)` 改为基于缩放后横坐标 `xs` 与标签字符串长度估算的碰撞过滤：
   - 保留首（左对齐）、尾（右对齐）两点；若连首尾标签之间都不足最小净距（`16px`），仅保留起点。
   - 对中间候选点（`1 .. last - 1`），按居中对齐计算其水平占位 `[x - width/2, x + width/2]`，筛选同时与左、右端点标签保持 `≥ 16px` 净距的候选，取最接近几何中点 `(xs[0] + xs[last]) / 2` 的一点；无安全候选时省略中间刻度，仅渲染首尾两点。
2. [TrendChart.tsx](../../../src/client/TrendChart.tsx) 传入 `xs` 与各点 `label`；[tests/trend-chart.spec.ts](../../../tests/trend-chart.spec.ts) 与 [tests/trend-chart.client.spec.tsx](../../../tests/trend-chart.client.spec.tsx) 补充偏斜分布省略中点、几何中心选点及窄跨度回退测试。

## Alternatives considered

- **按时间中点插值生成独立刻度文本** —— 会脱离已分桶的数据点，与上方命中区及提示气泡里的桶时刻不再对齐；而原有 X 轴始终标注实际存在的数据点时刻，保留点对齐语义更直接。
- **隐藏或旋转 X 轴标签** —— 旋转在 190px 高的紧凑趋势图里会挤占绘图高度；仅在有安全净距时才渲染中间刻度即可零高度代价解决碰撞。

## Consequences

- 代价：时间极度偏斜且中间无点时，X 轴仅显示首尾两个时刻；字符宽采用与浮动提示一致的等宽估算（`6.6px/字符`），依赖 `11px tabular-nums` 样式约定。
- 换来：任何时间分布与容器宽度下都不会再出现 X 轴时间标签重叠；中间点在可用时真正落在视觉中心附近。
