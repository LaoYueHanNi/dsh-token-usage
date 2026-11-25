# DR: 卡片表面样式收敛为共享 surface 模块

Status: implemented

## Problem

仪表盘的大卡片（KPI 卡、趋势卡、按模型卡、最新请求卡、总页面四宫格、设置页明细面板）共用同一套视觉：1px 边框、顶部 180° 淡色渐变、内阴影顶边，以及 hover 时边框提亮加外阴影。这段约 20 行的声明分别复制在 `StatCard`、`UsageView`（两处）、`OverviewBoard`、`DashboardCards`、`TokenUsageSection` 六个规则里，渐变强度和阴影强度又各有细微差异（2.6%/3.2%、4%/4.5%/5% 等），状态微光卡片（`cardAccent*`、`latestGlow*`）还要把整段 `background` 再抄一遍。往价格总览弹窗等新位置推广时，会继续扩散这些副本。

## Decision

1. 新增 [surface.module.css](../../../src/client/surface.module.css)，导出 `.surface`，统一负责边框、渐变底色、内阴影顶边、hover 提亮及过渡。组件在 TSX 里把 `surface['surface']` 和自己的布局类并列挂上，圆角与内边距仍留在各自模块。
2. 差异通过元素自身声明的 `--dtu-surface-*` 自定义属性调节（填充、边框、hover 边框、渐变强度与淡出位置、顶边强度、外阴影位移与强度，以及额外一层 `--dtu-surface-wash`）。`.surface` 只在 `var()` 回退值里给出默认值，自身不声明这些属性，所以不论各模块 style 标签的注入顺序如何，变体都能生效。
3. 状态微光改为只设置 `--dtu-surface-wash`（径向渐变）和必要的边框变量，不再整段重写 `background`。
4. 同步推广：价格总览弹窗的模拟四桶胶囊接入 `.surface`（layer-2 填充），四个桶标签内嵌 `BUCKET_DOTS` 语义色点并改用内容自适应分栏（`.bucket` 设 `flex: 1 1 auto`、`.bucketInput` 设共享基础宽度与 `box-sizing: border-box`、`overflow: hidden`、弹窗最大宽度扩至 `780px`，视口 `≤ 680px` 折为 2×2），避免长标签挤压缓存读/写输入框；K/M/B 单位切换由三格拼接矩形改为内嵌圆角分段槽与浮动高亮药丸；预设案例按钮改为带场景说明（极高缓存 / 高缓存 / 翻译场景）和指示点的全圆角芯片，以柔和顶边高光渐变替代硬边框选中态；输入框旁费用胶囊面板的「Token · 命中率」行前加 `KPI_ICONS`；列表卡头的排序分段与性能开关补上 hover 边框提亮和过渡。
5. 设置页插件卡片（`TokenUsageCard`）与宿主菜单外观的弹层（CostPill、QuotaButton、DateRangePicker、MenuSelect 面板）不接入，前者要和宿主原生设置卡片保持一致，后者已有宿主阴影层次。

## Alternatives considered

- **CSS Modules `composes: surface from './surface.module.css'`** —— 本仓库的 tsdown 插件用 lightningcss 逐文件编译后只取导出的本地类名，跨文件 `composes` 的依赖类既不会并入类名映射，也不会注入对应样式；要支持它就得改构建插件，而且 vitest 下的行为也要单独对齐。
- **在 `:root` 定义全局渐变/阴影变量** —— 引用 `--dsw-*` 主题令牌的自定义属性在 `:root` 上就被计算成具体值，子树里切换的主题无法传到下层；同时会往宿主全局命名空间写入插件变量。
- **保持各模块复制** —— 推广到弹窗后副本会增加到八处以上，强度数值已经开始漂移，后续调整很难保持一致。

## Consequences

- 代价：每个卡片元素多挂一个类名，TSX 要显式导入 `surface.module.css`；`--dtu-surface-*` 会被后代继承，嵌套另一张 surface 的元素只能设置后代也需要的属性，否则内层要自己重新声明。
- 换来：卡片外观只在一处维护，变体只写差异数值；状态微光不再复制底层渐变；新位置接入只需挂一个类名。
