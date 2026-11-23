# DR: 设置面板 Token 用量扩展页的开关驱动注册

Status: implemented

## Problem

主列大屏（侧边栏「更多」菜单或常驻侧边栏入口）已完整承载全量统计看板，部分习惯走侧边栏大屏的用户不再需要「设置 → Token 用量」扩展页，希望能在插件设置里将其关闭以保持设置面板简洁，同时对升级用户默认保留该入口。

## Decision

- Config 新增 `settingsSectionEnabled` volatile 布尔字段（缺省为 `true`，即未设置或 `true` 时均开启，仅显式 `false` 时关闭）。
- 插件配置卡（`TokenUsageCard`）在「常驻侧边栏」下方新增「在设置中显示 Token 用量」（`Show Token Usage in Settings`）复选框，与 `sidebarPinned` 同样采用暂存式编辑：`editSettingsSection` 仅更新本地暂存态并点亮「未保存」徽章，不阻塞定价表同步（`textDirty` 不受影响），点击「保存」时显式写入 `true`/`false` 并读回校验。
- 浏览器半区将原本静态的 `settings.section` 注册并入 `syncEntries` 动态同步器：经 `ctx.slots.inject('settings.section', ...)` 等待宿主声明后，当快照值 `settingsSectionEnabled !== false` 时注册 `settings.section`（id `token-usage`），当读到 `false` 时调用 disposer 注销该扩展页；配置目标尚未就绪（`loading` / `unavailable`）时按默认开启处理。

## Alternatives considered

- **直接移除 `settings.section` 入口** —— 会破坏习惯从设置面板查看统计的用户体验，且在不支持 `main` / 侧边栏入口的旧壳上会彻底失去全局统计入口。
- **在 `TokenUsageSection` 组件内部判空返回 `null`** —— `settings.section` 的导航项由 slot 注册表根据注册条目生成，仅让组件渲染空内容仍会在设置面板左侧留下一条空白的「Token 用量」导航页签，必须通过动态注册/注销 slot 来控制导航项显隐。
- **非 volatile 的静态 `cordis.yml` 字段** —— 用户必须手动编辑配置文件并重载插件，与「常驻侧边栏」在配置卡上一键保存即时生效的交互不一致。

## Consequences

- 代价：`Config` 与 `CardForm` 增加一个 volatile 布尔字段，`syncEntries` 同步器同时管理设置面板与侧边栏两类入口的生命周期。
- 换来：用户可在插件页配置卡上随时关闭或恢复「设置 → Token 用量」扩展页，保存后无需重载即时生效，默认行为与既有版本完全兼容。
