# DR: 筛选栏快捷区间与模型下拉替换为自绘菜单弹层

Status: implemented

## Problem

快捷区间（1d/7d/30d/自定义）与模型筛选用的是原生 select：闭合态虽已用 appearance:none 套了主题皮肤，但展开后的选项列表由浏览器 UA 渲染，不吃任何设计 token（shell 不给插件内容设 color-scheme），与新落地的日期区间弹层（见[区间选择弹层](../implemented/2026-08-30-range-date-picker-popover.md)）在材质、配色、行为上割裂——用户观感即"这两个还是原生的"。

## Decision

新增自绘组件 src/client/MenuSelect.tsx（样式 MenuSelect.module.css），FilterBar 的两个 select 替换为它，使筛选栏三个控件共用一套弹层语言：

- 触发按钮沿原 select 闭合态的控件家族样式（同盒度量、同中性灰 chevron），grow 变体复刻原 modelControl 的收缩/上限/省略（min-width:0、max-width:220px、ellipsis）。
- 弹层与日期弹层同板材：--dsw-specific-menu 底、border-inverted 边、shadow-lv3、z-index 100，向下弹出；选项行 hover 高亮，选中项品牌色 + ✓，列表 max-height 240px 内滚动。
- 语义用 role=listbox/option + aria-selected（trigger 加 aria-haspopup/aria-expanded）；键盘走 listbox 惯例：打开（trigger 点击/Enter/方向键）即聚焦选中项并居中滚入视口（scrollIntoView，jsdom 下守卫跳过），ArrowUp/Down 与 Home/End 漫游（选项 tabIndex=-1，Tab 跳过列表），Enter/Space 提交所在行，Escape 关闭并回焦 trigger，提交后同样回焦；面板外 pointerdown 关闭不抢焦点。
- 交互照抄 QuotaButton 模式（document pointerdown 外点关 + Escape 关）；选中即关闭并上抛值，取消不改值。"自定义"项纯展示（镜像日期区间，点击不回写），保持原 select 的行为。
- locale 零新增（复用 filter.quickRange/custom/model/allModels）；TokenUsageSection.module.css 删除废弃的 .control/.modelControl。

## Alternatives considered

- **保留原生 select 仅调闭合态样式** —— option 弹层是 UA 私有渲染，token 化不可能；暗色下白底列表的问题正是要消除的割裂本身。
- **给插件区设 color-scheme 让 UA 弹层跟主题** —— 弹层归属操作系统/浏览器 UA 样式，跨平台表现不受控，且材质仍与自绘弹层完全不同源，统一视觉的目标达不到。
- **共用一个泛化 Popover 容器组件** —— 当前仅两种弹层形态（日历/菜单），行为差异大于共性，抽共享容器的抽象成本高于三处 ~15 行的关闭 effect 复制（QuotaButton 亦如此，属既有约定）。

## Consequences

- 换来：筛选栏三控件弹出层材质、交互、取消语义完全统一；选项列表全 token 化，明暗主题与主题切换即时跟随；选中标记可读屏。
- 代价：失去原生 select 的免费能力——type-to-find 前缀跳字仍未复刻（方向键漫游、Enter 确认与打开滚到选中项已补齐）；模型列表很长时依赖面板内滚动（max-height 240px）；组件与测试由插件自行维护。
