# DR: 筛选栏日期改为单触发器两次点击的区间选择弹层（跨月保留进度）

Status: implemented

## Problem

设置页「Token 用量」的日期筛选由两个独立的 `<input type="date">`（开始/结束）构成：改区间要在两个控件间来回，逐个编辑的过程还会经过 from > to 的倒置中间态（靠 lastValidQueryRef 挡住无效请求），且两个原生输入框与"一段日期区间"的心智模型不符。需求是把日期控件合成一个整体：点击弹出日历，第一次点击确定起或尾，第二次点击确定另一端，且月份跳转不得丢失已选的第一下进度。

## Decision

新增自绘组件 `src/client/DateRangePicker.tsx`（样式 `DateRangePicker.module.css`），FilterBar 中两个 date input 与分隔符替换为这一个受控组件，Props 为 `{ from, to, onChange }`（'' = 不约束）；`Filters` 接口、`filterQuery` 倒置防线、快捷区间派生（isQuickActive）、fetch 联动全部不动：

- 两击状态机：第一击落 anchor（起点或终点皆可），第二击取 min/max 排序后经 onChange 提交并关闭；hover 在 anchor 存活期间预览待定区间。
- 跨月保留：显示月份 viewMonth 与 anchor 是分离的状态，上/下月导航只改前者；anchor 以 day key 存储，与显示月解耦，翻回后仍高亮（日格 aria-pressed 暴露端点/锚点态）。
- 取消语义：Escape 或面板外 pointerdown 关闭即丢弃未完成的 anchor（提交的 filters 不变、不发请求）；重开从第一击重新开始。
- 清除按钮把区间释放回 `{ from: '', to: '' }`，保留原双输入框可清空（"全部日期"）的能力；快捷区间菜单同步提供 ALL 条目（复用 filter.allDates 文案，列于 1d/7d/30d 之后），一键释放区间免开日历，派生逻辑在 from 与 to 皆空时显示 ALL（与清除按钮同一状态，两入口互通）。
- 网格纯函数 `monthGrid`/`shiftMonth`/`monthViewOf` 落在 `src/client/day.ts`（周一起始整周网格，本地时间构造器，非当月格渲染为空白占位保持当月日期文本唯一）。
- 弹层交互照抄 QuotaButton 的已验证模式（document pointerdown 外点关 + Escape 关），面板样式沿用其菜单板材（--dsw-specific-menu / border-inverted / shadow-lv3 / z-index 100），选中态用 --dsw-alias-brand-primary 描边（shell 无 selected 背景 token）。
- locale：新增 filter.dateRange / filter.allDates / filter.clear 与 calendar.* 系列（月份标题、前后月导航、周一至周日表头），删除不再引用的 filter.from / filter.to。

## Alternatives considered

- **保留双 `<input type="date">` 只做样式合并** —— 仍是两步两控件，无法满足"点击第一下、再点击一次"的整体交互诉求，倒置中间态问题也依旧存在。
- **引入第三方日历库（react-day-picker 等）** —— 本插件浏览器半边零 UI 运行时依赖，为单一弹层引入库与构建/内联复杂度不成比例；自绘网格核心仅约百行且纯函数可测。
- **用原生 `<dialog>` 模态承载日历** —— 定价弹窗已用该模式，但模态遮罩对筛选栏这种轻量交互过重；QuotaButton 的非模态 popover 模式（外点/Esc 关闭）更贴合且已在 shell 内验证。

## Consequences

- 换来：日期筛选成为单一控件的两击流程（顺序无关、自动排序）；跨月选择进度在月份跳转间保留；取消零副作用；能力与原双输入框对等（含清空）；零新增运行时依赖。
- 代价：日历网格、月份导航与弹层可达性由插件自行维护（shell 不提供日历原语）；未完成的第一击在关闭后被丢弃（跨开合不保留，与主流 range picker 一致）；周一起始未按 locale 分化（中英共用，接受单一排布）。
