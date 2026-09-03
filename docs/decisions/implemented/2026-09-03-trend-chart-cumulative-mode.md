# DR: 趋势图新增分时/累计切换，累计为归一化点集上的前缀和

Status: implemented

## Problem

用量 tab 的趋势图只表达"每个时间段用了多少"（分时总量）：请求桶模式画每桶 tokens、日/小时模式画每天/每小时总量，无记录的时段跌到零。它回答不了"这个会话到现在一共烧了多少、消耗速度如何"——那需要一条单调上升的累计曲线。用户希望在「趋势」标题右侧加一组「分时 / 累计」二选一按钮，且横坐标（分桶、时间比例缩放、点数）完全不动，仅换纵坐标语义。

## Decision

**累计实现为 `buildChartPoints` 之后的正交前缀和变换；`TrendChart` 以可选 prop 接收模式，默认分时。**（`src/client/trend-chart/points.ts`、`src/client/TrendChart.tsx`、`src/client/UsageView.tsx`）

- 新增纯函数 `cumulateSeries(series: ChartSeries): ChartSeries`：对归一化后的点集顺序累加，每点 `tokens` 替换为运行总和，其余字段（`key/label/full/time/count`）浅拷贝保留，入参不变。三种模式（请求桶/小时/日）的点集都时间升序，一次正向折叠对全部模式正确，无需按模式分支。
- `TrendChart` 加 `mode?: 'interval' | 'cumulative'`（默认 `'interval'`）：`buildChartPoints` 返回 null 仍走空占位；非 null 时 `cumulative` 模式换用前缀和序列，之后的 y 轴刻度（`tickValues` 以最大值为基，累计序列末点即总量）、path、点、命中区全部由数据驱动自动跟随，渲染器无其他改动。
- 文案与无障碍：累计模式 tooltip 只显示累计值——日/小时点用 `chart.cumulativePoint`（「{day} 累计 {tokens}」）、请求桶用 `chart.cumulativeBucket`（「{window} · {count} 请求 · 累计 {tokens}」，`count` 仍是本桶请求数）；图表 aria 统一 `chart.ariaCumulative`，不复用分时的「每日/分时/按时间分段」措辞（那描述的是区间总量，对运行总和是撒谎）。`tipOf` 是 tooltip 与逐点 aria 的单一来源，两处一起换。
- `UsageView` 持 `useState<TrendChartMode>('interval')`，标题与按钮组包进 `chartHead`（flex，同 `subagentsHead` 模式），按钮组复用 scope 开关的 `segmented/segBtn/segActive` 样式与 `role="group"` + `aria-pressed` 结构。切换状态不持久化，与 scope 开关同一哲学（会话内临时视角）。
- 切换是纯客户端重渲染，不触发新 fetch（requestSeries 已在手）。
- 设置页 `TokenUsageSection` 的 `TrendChart` 调用不传 `mode`，默认分时，零改动。

## Alternatives considered

- **给 `buildChartPoints` 加 mode 参数、在三个分支里分别累加** —— 建点与"读数变换"是两个正交关注点，混进同一签名让测试矩阵翻倍且每个分支重复同一循环。否决：前缀和作用在归一化点集上一次覆盖三模式。
- **在 `TrendChart` 渲染器里内联累加** —— 渲染器定位是纯展示（模块头注释明言 bucketing/scaling/shape 决策在 `trend-chart/*`），内联则无法像 `scaleSeries`/`bucketSeries` 那样脱离 React 单测。否决。
- **tooltip 同时显示本段增量与累计（「+12.4K · 累计 87.2K」）** —— 信息更全但文案更长，且需要在前缀和之外保留每点原始值（结构加字段或双序列）。用户选择只显示累计值。否决。
- **累计模式复用分时 aria（`chart.aria` 等）** —— 「每日总 token 曲线」对单调累计曲线语义错误，屏幕读者得到的概览与图不符。否决：新增单一 `chart.ariaCumulative`，粒度细节已在逐点 tooltip 里。
- **切换状态持久化（localStorage/设置）** —— scope 开关也未持久化；这是查看视角而非数据口径，记住上次选择反而让"为什么默认是这个"不可预期。否决。

## Consequences

- **所得**：三条粒度曲线（请求桶/小时/日）免费获得累计视图；x 轴、分桶、命中区、浮动标签几何零改动；设置页与其测试完全不受影响（可选 prop 默认值）；`cumulateSeries` 纯函数可独立测试（含"空时段变平台"语义）。
- **代价**：6 个新 locale key ×2 语言；`tipOf` 签名加 mode 参数（两处调用点跟随）。
- **边界**：累计模式下无记录时段从"跌到零"变为"水平平台"——这是运行总和的正确语义，但与分时视图的视觉习惯不同（单日小时曲线呈"前段贴零平台→活跃爬升→末段水平"）；切换不触发请求，随 `requestSeries` 快照变化自然刷新。
