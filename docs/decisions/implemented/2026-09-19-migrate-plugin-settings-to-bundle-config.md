# DR: 适配宿主 dsh 0.1.6 插件配置体系（迁往 plugins.bundle.config 插槽并平滑兼顾旧版）

Status: implemented

## Problem

宿主 DeepSeek Harness 自 `dsh-v0.1.6-alpha.2`（commit `90af3110b7` *feat(web): host plugin configuration on the Plugins page*）起对插件配置体系进行了架构重构：
1. **全局设置页只保留清单**：原全局【设置】面板中的 `settings.plugin.item` 插槽被彻底退役删除，设置分区不再挂载任何第三方插件的配置卡片。
2. **插件管理页承载配置**：插件的配置表单全面迁至左侧导航栏的【插件】（Plugins）列表详情页，通过三个子 slot 呈现。其中组合包自身的配置通过 `plugins.bundle.config`（以组合包包名 `@laoyuehanni/dsh-token-usage` 为 key）渲染在描述与组件列表之间，并向组件传入 `{ view: 'page' | 'summary' }`。
3. **表单生命周期**：新版规范规定未保存的暂存修改在离开页面（组件卸载）时自动丢弃，仅在用户显式点击保存时提交。

由于本插件此前仅注册了已退役的 `settings.plugin.item`（key 为 `'token-usage'`），导致在新版宿主下：
- 点击全局设置看不到插件配置；
- 进入左侧插件管理列表点击 `token-usage`，详情页内本应展示配置表单的位置完全空白。

## Decision

立足**“生态最大化向后兼容”**原则——只要具备兼容技术路径，坚决保持双向平滑兼容，绝不因宿主升级而强行提升最低版本要求，仅在底层完全不可逆或无法兼容的极端情况下才考虑破坏性升级。具体落地为：

1. **双插槽注册（平滑兼容两代宿主）**：
   在客户端入口 `src/client/index.ts` 中，通过声明合并（declaration merging）补充 `plugins.bundle.config` 的 SlotMap 类型，并将配置卡片同时向两个插槽注册：
   - 新版插槽：`plugins.bundle.config`，key 设为完整包名 `'@laoyuehanni/dsh-token-usage'`。
   - 旧版回退插槽：`settings.plugin.item`，key 设为 `'token-usage'`。
   由于 `ctx.slots.inject` 会按需等待宿主环境对插槽的实际声明，在新版 Harness 下自动激活 `plugins.bundle.config`，在旧版 Harness 下自动激活 `settings.plugin.item`，无需分支发版。
2. **适配页面视图与初始状态**：
   `TokenUsageCard.tsx` 接收可选的 `view` 属性：
   - 当 `view === 'summary'` 时直接输出简洁描述文本；
   - 当在详情页作为配置主体渲染时（`view === 'page'`），卡片折叠状态 `open` 默认设为 `true`（直接展开表单呈现路径选择、区域镜像与同步控制）；在旧版或未传 `view` 的场景下保持默认收起以维持既有行为；
   - 增加 `useEffect(() => () => props.discard(), [])`，页面离开/卸载时自动丢弃暂存编辑，契合新版表单规范。
3. **更新加载顺序声明**：
   在 `package.json` 的 `dsh.client.inject` 声明中同时保留旧依赖并补充新依赖：保留 `"@deepseek-ai/dsh-client-ui-settings-plugins"`（保障旧版宿主正常触发），并追加 `"@deepseek-ai/dsh-client-ui-plugin-manager"`（保障新版宿主按拓扑顺序优先激活插件管理器）。
4. **稳定 peerDependencies 依赖范围**：
   维持对 `^0.1.2-rc.1` 的兼容依赖范围，不因适配新版宿主而强行提升 `peerDependencies` 版本下限，确保 0.1.2~0.1.5 的老用户能够直接平滑升级插件。
5. **测试覆盖**：
   在 `tests/token-usage-card.client.spec.tsx` 中补充 `view: 'summary'`、`view: 'page'` 默认展开以及卸载自动 discard 的断言，既有 29 项测试全部保持通过。

## Alternatives considered

- **强行提升最低依赖并切断旧版支持（仅支持 `plugins.bundle.config`）**：
  直接将插件依赖升级锁定至 `0.1.6+` 并删除全部 `settings.plugin.item` 兼容代码。虽然实现极其简短，但会逼迫所有处于 0.1.2~0.1.5 稳定环境的现有用户必须跟随升级宿主方可使用插件，破坏生态兼容性；鉴于双向注入和条件兜底成本极低（仅增数十字节），坚决否决破坏性升级。确立“能兼容必须兼容，只有在底层架构或 API 彻底无法兼顾时才允许强推升级”的设计红线。
- **重构移除外层卡片与头部折叠结构**：
  详情页中官方 Card 大多无折叠包裹。但保留可折叠外壳兼顾了标题状态徽章（如“未保存”提示、折叠查看组件列表的空间弹性）及向后兼容，仅需根据 `view === 'page'` 默认展开即可兼得两边优势。

## Consequences

- **所得**：在新版 Harness 插件管理页面中，进入 `token-usage` 即可直接看到完整的数据目录配置、镜像区域下拉框与全量历史扫描进度；在旧版 Harness 设置面板中同样能正常加载。
- **所得**：旧版 DSH（0.1.2~0.1.5）用户与新版 DSH（0.1.6+）用户共享同一个插件版本，无破坏性升级风险。
- **所得**：全量单测通过（688 项），类型检查通过（0 错误）。
- **代价**：客户端 bundle 产物略微增加几十字节；多保留了一套旧版插槽的回退调用逻辑与双向依赖声明。
