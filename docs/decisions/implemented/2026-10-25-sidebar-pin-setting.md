# DR: 用量入口常驻侧边栏的设置驱动注册

Status: implemented

## Problem

用量入口目前只有侧边栏「更多」菜单一行（`sidebar.panellist.actions`）与旧宿主的设置区入口。高频查看用量的用户每次都要多点一次「更多」。需要一种可从网页设置开关的方式把入口固定为侧边栏常驻行，且默认保持「更多」菜单形态、开启关闭即时生效。

## Decision

- Config 新增 `sidebarPinned` volatile 布尔字段（默认关）。设置卡片的开关与目录/区域一致走暂存式编辑：`editPinned` 只暂存勾选（计入「未保存」徽章），随「保存」一起写入并读回校验；写入显式 `true`/`false` 而非 unset，避免 composition 层设 `true` 时从界面"关不掉"。volatile 提交让保存免插件重载即时生效。
- 浏览器半区跟随活动配置目标的快照（首次读取加每次提交变化，`configForms` 与 `settingsScope` 两个来源同样覆盖）：读到 `true` 时向 `sidebar.panellist` 注册一行（id 与 `main` 面板同键、`order: 50`、label 走语言跟随的 thunk）并注销「更多」菜单行；读到 `false` 时相反。两个入口互斥，任何时刻只存在一个——常驻后「更多」菜单里不再重复出现「Token 用量」。目标未就绪（describe 加载中）时按默认关闭处理，只有「更多」菜单入口。
- 壳的语义是「注册即常驻」：`sidebar.panellist` 的每个注册项默认显示，壳的 unpin 列表仅是会话内内存态，因此不驱动壳的 pin API——注册本身就是持久固定，注销即回到「更多」菜单。
- 两个注册都由同一同步器管理，且都经 `slots.inject` 等待各自的壳声明（旧壳的回调永不运行，静默降级为仅设置区入口）；注册行经 `ctx.effect` 清理，插件卸载不留残留行；register 被拒（同优先级占用）时对应入口缺席，不影响激活。

## Alternatives considered

- **驱动壳的内存 pin API（`setPinned`）** —— pin 状态仅存于内存（插件重载即失），且与用户在「更多」菜单里的手动 unpin 互相打架：设置每次生效都会把用户手动收起的行再顶回来。注册与注销由插件自己拥有，两态清晰可预期。
- **默认常驻，不提供设置** —— 对不看用量的用户是纯噪声；入口价值因人而异，交给设置决定。
- **composition（cordis.yml）字段** —— 只能手改配置文件并重启生效，与现有网页设置卡片的编辑体验割裂；volatile 字段让保存免重载生效。

## Consequences

- 代价：Config 多一个进入 describe 投影的 volatile 字段；常驻行的可见性由设置文档决定，用户层覆盖 composition 层的语义与 `path`、`pricingRegion` 一致。
- 换来：高频用户一键常驻、随时可关；关闭时入口仍在「更多」菜单，不存在失去入口的状态；旧宿主自动降级，无新依赖。
