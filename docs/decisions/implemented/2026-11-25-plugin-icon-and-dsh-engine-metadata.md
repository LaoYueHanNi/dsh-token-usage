# DR: 补充插件图标（icon.svg）与 engines.dsh 兼容声明

Status: implemented

## Problem

DSH 0.2.2 的插件管理页支持读取插件包 `package.json` 顶层的 `icon` 字段与 `engines.dsh` 兼容声明：

1. 本插件此前未提供 `icon.svg`，在插件管理页和组件列表里仅展示宿主默认占位图标，辨识度偏弱；
2. `package.json` 仅在 `peerDependencies` 中隐式反映 `@deepseek-ai/dsh-*` 最低版本（`^0.2.1-rc.3`），未在 `engines.dsh` 显式声明兼容宿主范围。

## Decision

1. **新增自包含矢量图标**（[icon.svg](../../../icon.svg)）：
   - 遵循 DSH 插件图标规范：使用 `width="36" height="36" viewBox="0 0 36 36"`，不画背景瓷砖（由插件管理页统一绘制圆角底板），不使用 `<script>`、`<style>`、`<text>`、`<image>`、`foreignObject` 或事件属性；
   - 以「用量仪表盘（Gauge）」为主体，与侧栏常驻入口图标保持同一心智；采用与官方内置插件一致的蓝紫渐变圆盘（`#7AC2FF → #4A65E8`）叠加青绿至纯白进度弧（`#62F2B6 → #FFFFFF`）和纯白指针，在浅色/深色主题的 24px 行级与 36px 卡片级尺寸下均保持清晰辨识度与一致光学重量。
2. **补全 `package.json` 生态元数据**（[package.json](../../../package.json)）：
   - 顶层声明 `"icon": "./icon.svg"`，并在 `"files"` 数组中收录 `"icon.svg"`，确保发布包包含图标文件；
   - 在 `"engines"` 中新增 `"dsh": ">=0.2.1-rc.3"`，与当前 `peerDependencies` 和运行时双兼容下限保持一致。
3. **契约单测守护**（[tests/locale-meta.spec.ts](../../../tests/locale-meta.spec.ts)）：
   - 断言 `package.json` 的 `icon`、`files`、`engines.dsh` 声明以及 `icon.svg` 存在性、256 KiB 体积上限与自包含几何约束。

## Alternatives considered

- **使用 PNG 光栅图标**：体积较大且在高 DPI 缩放下清晰度不如矢量 SVG；本图标几何简洁，纯 SVG 仅约 1 KiB。
- **把 `engines.dsh` 抬高到 `>=0.2.2`**：本插件对 `0.2.2` 新能力均采用运行时探测与降级，仍完整支持 `0.2.1-rc.3`，因此如实声明 `>=0.2.1-rc.3`。

## Consequences

- 在 DSH 0.2.2+ 插件管理页中，本插件展示专属仪表盘图标与明确的宿主最低版本声明；旧版宿主安全忽略未知字段，无兼容影响。
- 本次未改动插件版本号，多语言扩展与模糊搜索留待后续按需推进。
