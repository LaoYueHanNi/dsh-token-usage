# DR: 插件包以 locale/*.json 承载本地化显示元数据

Status: implemented

## Problem

宿主 `dsh-app-boot` 会为每个插件包读取一份"本地化显示元数据"：插件管理列表中的标题与描述不再直接取 `package.json` 的 `name`/`description`，而是经 `dsh-client-locale` 的 `resolveText()` 按当前界面语言取值。链路是：宿主先经 Cordis `ModuleLoader` 解析 `<包名>/locale/en.json`，再用它所在目录做 `readdirSync` 扫描整份词典集，每个 JSON 读出 `meta.title` / `meta.description` 合成为 `{ en: <package.json 原值>, zh: "..." }`，前端按"精确 id → 主语言 subtag → en"的 fallbackChain 取值。

中文用户打开插件管理列表时，看到的仍是包名 `@laoyuehanni/dsh-token-usage` 与英文 description。要接入这套本地化，必须同时满足四个条件，缺任一则**静默失效、不报任何错**：

1. `locale/zh.json` 承载中文 `meta.title` / `meta.description`，两个字段都须非空字符串（空串让宿主 `textOf()` 抛错），文件名须匹配语言 id 正则 `^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$`
2. `locale/en.json` 内容为 `{ "meta": {} }`，它是**目录扫描的锚点而非占位符**：缺失时词典集为空 Map，同目录的 zh.json 被一并忽略
3. `package.json` 的 `exports` 放行 `"./locale/*.json": "./locale/*.json"`，否则 `optionalResourcePath()` 返回 undefined
4. `package.json` 的 `files` 收录 `"locale"`，否则 `npm pack` 漏掉该目录

四个条件横跨磁盘布局、包导出白名单与打包清单，任意一处被后续改动删掉都只表现为"中文文案消失"，没有可观测的失败信号。

## Decision

新增包级本地化词典目录，用宿主既有的四段式解析链路承载中文元数据：

- `locale/en.json` 为 `{ "meta": {} }`（扫描锚点；meta 留空即表示沿用 `package.json` 原值，英文界面行为与改动前逐字相同）
- `locale/zh.json` 为 `{ "meta": { "title": "Token 用量", "description": "…" } }`，语言 id 用 `zh` 而非 `zh-CN`（宿主内置语言表只有 `zh`/`en`）
- `package.json` 的 `exports` 增加 `"./locale/*.json": "./locale/*.json"`，`files` 增加 `"locale"`
- `package.json` 的 `name` 保持 npm 作用域包名不动：它同时是 npm 包名与宿主加载时的 specifier

中文 `meta.title` 与插件自身 UI 的 `card.title` / `nav.label` 同取「Token 用量」，保证插件管理列表与插件内页面的称呼一致。

验证走真实打包产物而非本地文件存在性：`npm pack` 后确认清单含两个 locale 文件，再复刻宿主解析路径（经 `ModuleLoader` 解析 en.json → 目录扫描 → `localizedText()` 合成 → 真实 `LocaleRuntime.resolveText()` 取值），对中文界面命中 zh 文案、英文界面回落到 `package.json` 原值两侧各断言一遍，并反证删掉 en.json 后 zh 确实被静默忽略。

## Alternatives considered

- **把中英拼进 `description` 单字段** —— 单字符串无法按语言切换，英文界面会露出中文尾巴，等于把一个静默失效换成另一个。输。
- **改插件自己的 `src/client/locales.ts` 字典** —— 那套经 `ctx.locale.register(NS, { zh, en })` 驱动插件自身 UI，与包级 `meta` 是两套独立机制，管不到插件管理列表卡片。输。
- **patch 宿主 `packageText()` 硬编码中文** —— 全局影响所有第三方插件，把一个包的显示问题变成宿主行为变更。输。
- **改 `package.json` 的 `name` 为中文名** —— 破坏 npm 包标识与宿主加载 specifier，插件直接装不上。输。
- **只放 `zh.json`，不放 `en.json`** —— en.json 是宿主目录扫描的锚点，缺失时 zh.json 被一并忽略且无任何报错，等于什么都没做。输。

## Consequences

- 代价：随包多分发一个目录与两个 JSON；四个条件中任一被后续改动删掉都是静默失效（不报错、只表现为回退英文），没有编译期或测试期的失败信号，只能靠 review 与"对打包产物跑一遍解析链路"来守住。
- 换来：中文界面下插件管理列表显示「Token 用量」与中文描述，英文界面与改动前完全相同；新增语言只需在 `locale/` 放一个同构文件，不必触碰 `package.json` 的 `name`/`description`。
- 边界：这套机制只覆盖插件管理列表的标题与描述，插件内部 UI 文案仍由 `src/client/locales.ts` 维护，两边需要手工保持措辞一致。
