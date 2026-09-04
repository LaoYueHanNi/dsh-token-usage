# DR: 请求桶趋势图空隙插顶点，不把增量插值到空档

Status: implemented

补全 [`2026-09-03-trend-chart-cumulative-mode`](./2026-09-03-trend-chart-cumulative-mode.md)：该条的「空时段变平台」依赖点集里已有空点；请求桶不输出空桶，直线会把一次突发用量摊到整段闲时。

## Problem

会话趋势图只画有请求的桶，横坐标按墙钟比例拉开空隙。相邻点用 `M/L` 直连时，21 小时空档上的 18M 会看起来像一整夜匀速烧掉。累计、分时同一根因。

## Decision

**原折线加空隙补丁，不改分桶和 wire。**（`src/client/trend-chart/path.ts`、`scale.ts`、`points.ts`、`TrendChart.tsx`）

- `gapAfter`：`next.time > prev.end` 为空隙（`end` 开区间，相邻桶 `next.start === prev.end` 不算）。
- `seriesPath`：`polyline` 或 `gap`。`gap` 的相邻段仍是直 `L`；空隙从上一桶 `end` 落到 hold y，横到下一桶开始前一个桶宽，再折进去。分时 `hold: 'zero'`，累计 `hold: 'previous'`。
- temporal 点带上已有的 `bucket.end`；`scaleSeries` 同域算出 `xEnds`。圆点仍打在桶 start。

## Alternatives considered

- **`bucketSeries` 填空桶** —— 与 host 下采样共用，wire 变密、轴上铺零点。否决：只在路径上插顶点。
- **全图阶跃 / 按 `[start, end)` 占宽** —— 密簇变成直角台阶，不像折线。否决：相邻仍折线。
- **累计空隙也掉到 0** —— 运行总和变成「烧光再回来」。否决：横线停在上次累计值。

## Consequences

- **所得**：突发用量不再摊到空档；有请求的时段仍是原来的折线。
- **代价**：temporal 点多 `end`；`scaleSeries` 多返回 `xEnds`。
- **边界**：接入段宽一个桶，长横轴上仍然偏陡，但是斜线不是插值跨空档。
