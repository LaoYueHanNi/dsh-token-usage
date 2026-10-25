# DR: 设置页 Token 活动砖块日历与折线互切

Status: implemented

## Problem

设置中的 Token 用量页只有折线趋势，无法像 Codex 的 Token 活动视图一样沿日历快速辨认活跃日、活跃周和累计增长。用户需要每天 / 每周 / 累计总量三种砖块读数、进入时逐块渐进出现的动画，并能随时切回原折线；这些视角都不能改变当前日期 / 模型筛选或制造额外统计请求。

## Decision

新增独立的 `UsageChart`、`TokenActivity` 与纯函数 `activity-grid`，接入设置页原 `TrendChart` 座位：

- `UsageChart` 持有会话内的 `line / activity` 与 `daily / weekly / cumulative` 状态。默认仍是原折线（包括单日 24 小时分支）；砖块视图提供「每天 / 每周 / 累计总量」。切换只重渲染当前 `summary.byDay`，不改 filters、不持久化、不 fetch。会话用量 tab 的请求桶 / 分时 / 累计折线不在本次改动范围内。
- `activity-grid` 复用 `daySeries` 的本地日、inclusive range 与补零语义，生成周一开始、每周七行的日历。每天读取当日原始总量；每周先求该日历周在当前筛选内的原始日总量，再把同一周值填入其每天的位置，保持砖块几何不变；累计总量按日做前缀和。筛选边界的残周不外扩，tooltip 明确实际覆盖起讫。
- 色阶以当前读数最大值归一为「零 + 四档非零」，颜色全部由 `--dsw-*` 主题 token 的 `color-mix` 派生。单元格提供键盘焦点、精确 aria-label 与原生 title。
- 每块砖 mount 时以 WAAPI 执行 260ms 的透明度 / 位移 / 缩放动画，按时间顺序延迟 8ms，最大延迟 960ms；`prefers-reduced-motion` 或没有 WAAPI 时直接静态呈现，卸载取消动画。稳定 day key 使同视图数据刷新只更新颜色而不重播，主动切换读数或重新进入砖块视图才重播。
- 纯函数测试覆盖周一对齐、残周、闰日、累计与总量守恒、空 / 全零范围和色阶；DOM 测试覆盖互切、tooltip、渐进 delay 上限、更新不重播、卸载 cancel 与 reduced motion；设置页集成测试确认默认 1d 不扩张且切换零请求。

## Alternatives considered

- **把砖块分支塞进 `TrendChart` 的 SVG 渲染器** —— 折线的点集、比例尺和命中区与周历网格是两套几何，混进同一组件会破坏既有纯展示边界。否决：兄弟组件共享同一份 byDay。
- **切到砖块时自动改为一年 / 全部日期** —— 会把纯视图切换变成筛选修改并触发请求，默认 1d 也会毫无提示地丢失。否决：活动图严格呈现当前筛选；用户需要全年时选择「全部日期」。
- **每周改成滚动 7 天，或每周只留一个砖块** —— 滚动窗口不是日历周；单砖会破坏七行日历的位置对应。采用日历周总量在原每天位置重复呈现，并以实际周起讫 tooltip 避免残周误读。
- **用 CSS `@keyframes` 驱动全部砖块** —— 仓库已在 `cost-inflate-motion.ts` 记录嵌入式宿主的 CSS keyframes / custom-property 兼容问题。否决：复用其 `motionAllowed()`，在真实 DOM 节点上运行 WAAPI。
- **持久化视图与读数** —— 这是临时观察视角，与既有趋势 / scope 开关保持同一默认可预期原则。否决。

## Consequences

- 代价：新增两个 React 组件、一个纯数据模块、两套 CSS Module 与中英文文案；周模式的同日单元格共享一个周值，需要 tooltip 解释，且默认 1d 只有一块砖，需扩大既有筛选才能看到年历效果。
- 换来：设置页获得 Codex 风格的日 / 周 / 累计活动日历与渐进动画，同时保留原折线、筛选、数据口径和请求行为；host、wire 与统计存储完全不变。
- 累计仍沿用[归一化序列上的前缀和决策](./2026-09-03-trend-chart-cumulative-mode.md)，但活动日历有自己的砖块 aria / tooltip，不复用“曲线”文案。
