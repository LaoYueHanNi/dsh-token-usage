# DR: 趋势图采用单调样条曲线、柔白微光渐变与发光锚点，消隐冗余静态圆点

Status: implemented

## Problem

用量趋势图原实现存在明显的视觉粗糙与简陋感：
1. **静态实心点泛滥**：每个数据点无条件渲染实心白球，在 1d（24 小时）视图中连续数十小时为 0 时，底线上排布着 20 几个密集白球，杂乱僵硬；
2. **生硬折角尖刺**：原折线仅支持两点直线连接（Polyline），从 0 激增到峰值时折角尖锐突兀；
3. **缺乏层次呼吸感**：暗色底上只有单根硬白线，无面积渐变填充，视觉单薄冷硬；
4. **配色违和风险**：曾探索高饱和亮蓝主题色，但在 DSH 沉稳中性的暗色界面下过于刺眼扎眼；
5. **网格与 Tooltip 简陋**：网格线为高对比粗虚线，浮动 Tooltip 仅为紧凑单行文本。

## Decision

**保持 wire 契约和分桶几何不变，升级渲染层与几何计算：采用 Fritsch-Carlson 单调三次样条平滑、DSH 原生极简柔白微光面积填充、消隐静态冗余点并引入双层发光锚点。**（`src/client/trend-chart/path.ts`、`src/client/trend-chart/index.ts`、`src/client/TrendChart.tsx`、`src/client/TrendChart.module.css`）

- **单调三次样条（Fritsch-Carlson）**：新增纯函数 `monotoneSplinePath`、`gapPatchedPoints` 与 `smoothSeriesPath`。在相邻均为 0 的平坦区间斜率严格为 0，曲线死死贴紧基线，数学上彻底杜绝传统样条的负数下冲（undershoot）；在峰值处自然过渡为水平切线，曲线圆润流线。equidistant 模式（日/小时）与 temporal 模式（会话用量 tab 请求桶）均获得平滑曲线；temporal 模式在保留 [`2026-09-04-trend-chart-gap-geometry.md`](./2026-09-04-trend-chart-gap-geometry.md) 空档阶梯语义的同时，通过补齐 gap 顶点实现闲置平直贴地、起伏圆润丝滑。
- **DSH 极简柔白微光渐变（Monochrome Soft Glow）与日夜双模光学自适应**：新增纯函数 `areaPath(lineD, xs, yZero): string`，并在 `use-color-scheme.ts` 提供 `useIsLightMode` 精准监听 DSH 的 `document.documentElement.style.colorScheme`。SVG 内部根据主题注入垂直线性渐变：
  - **暗色模式（夜间）**：顶部 25%、中间 8%、底部 0% 柔白微光面积填充，主线统一收敛为 1.8px 精致线条并彻底移除 drop-shadow 辉光投影，消除模糊发散感，呈现干脆利落的现代纯黑白极简；
  - **浅色模式（白天）**：遵循白底透光减噪原则，顶部压制为 4.5%、中间 1.2%、底部 0% 的极致空气感轻薄微灰（Airy Slate Wash），主线 1.8px 纤细冷炭线无任何阴影，彻底消除暗色参数直套导致白底山峰出现浓重黑烟、污迹与粗苯沉重感的问题；
- **静态点消隐与双层交互光环**：默认状态下不再对多点序列渲染静态实心球（仅在总点数等于 1 时渲染孤立锚点防空屏）；当鼠标悬浮或键盘聚焦某点时，动态呈现外层半透明发光光晕（`dotHalo`，暗色 14% 透明度 / 亮色 7% 透明度，半径 6.5px）与内层实体圆点（`dotActive`，半径 3px，底边描边自适应当前背景色），彻底消除底线白球排成一排的粗糙感。
- **全图鼠标吸附与精致卡片 Tooltip**：SVG 感应层在移动时基于横坐标就近吸附最近数据点，准星竖线顺畅随动；每个点保留原有 `tabIndex={0}` 与 `aria-label`；Tooltip 卡片增强圆角（`rx="6"`）、外阴影与分层排版。
- **低扰网格线**：网格线调整为细密半透明微虚线（4 4 dash，暗色 60% opacity / 亮色 45% opacity），y=0 基线为干净平直细实线。

## Alternatives considered

- **引入第三方图表库（如 Recharts / Chart.js / Echarts）** —— 引入巨大外部依赖、增加 bundle 体积数十倍，且破坏 client bundle 工厂闭包分发机制。否决：手写 Fritsch-Carlson 零依赖纯数学实现，体积增加不足 1KB。
- **使用 DSH 品牌电光蓝（`#4D6BFE` / `--dsw-alias-brand-primary`）** —— 在深色工业风暗灰背景上过于荧光、对比过强且刺眼，破坏 DSH 中性克制的整体美感。用户明确否定。否决：回归 DSH 原生中性 `var(--dsw-alias-label-primary)` 与 10% 极淡渐变。
- **在所有模式（包括 temporal gap）下无脑统一应用平滑曲线** —— 会平滑跨越数小时的空闲停顿，违反 `2026-09-04-trend-chart-gap-geometry.md` 中"空闲时段不把增量插值到空档"的硬性业务契约。否决：equidistant 走单调样条，temporal gap 保留阶梯与折线。
- **保留默认静态小白圆点但调小半径** —— 即使缩小到 1.5px，在 20 几个连续 0 的底线上依然是一排麻点，视觉噪点仍然严重。否决：默认彻底消隐，仅在 Hover/Focus 时高亮发光。
- **在白天浅色模式下直接复用暗色渐变参数（25% 黑色不透明度）** —— 白底上 25% 黑色呈现大面积浓厚黑烟污迹，配合粗黑线条与黑阴影显得笨重而脏乱。否决：针对白底光学特性进行自适应降噪，改用 4.5% 超轻透气微灰与 1.8px 优雅冷炭线，无脏黑阴影。

## Consequences

- **所得**：1d 视图、7d 视图与会话趋势图整体质感大幅跃升为现代工业风仪表盘；消除了 20 多个无意义的底线白球；平滑过渡且不欠冲；完全融入 DSH 暗色与浅色主题，柔和不刺眼；键盘无障碍与屏幕阅读器能力完整保留；单测覆盖率进一步提升。
- **代价**：`TrendChart.tsx` 增加了面积渐变 `<defs>` 与鼠标滑动吸附监听器；`path.ts` 增加单调样条纯函数。
- **边界**：当点数 $\le 2$ 时退化为直线；当数据全为 0 时单调样条完全呈平底直线；temporal 模式下的 gap 几何保持直角平延阶梯，不强行曲线插值。
