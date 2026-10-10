# DR: 提供商前缀模型名归一化与本地关联映射

Status: proposed

## Problem

用量与计费路径里，插件从 model-price-table 拉取的定价镜像（`pricing.ccsa.json`，经 `cloudToTable` 与 `canonicalName` 展开）对 **modelId / aliases 做精确字符串匹配**（大小写敏感，不剥离 `provider/` 前缀）。当网关或客户端把模型写成带提供商前缀的全名时——例如 `z-ai/GLM-5.3`、`openai/gpt-6-astra`、`deepseek/deepseek-v4.1-flash`——表内虽有短官方 id 或别名，查找仍失败，页面显示未定价（¥0）并告警，即 [GitHub issue #10](https://github.com/LaoYueHanNi/dsh-token-usage/issues/10) 所描述的情形。

这不是 feed 缺价：上游表往往已有 `GLM-5.3`、`gpt-6-astra`、`deepseek-v4.1-flash` 等条目，而是 **本地用量名与表键不一致**。若把每一种 `provider/model` 组合都塞进上游 aliases，表会膨胀、维护分散，且与「定价数据单一上游源」的方向冲突。另一方面，[废除手工 pricing.json 定价文件机制](../implemented/2026-09-05-abolish-manual-pricing-json.md) 已明确不再允许用户本地写自定义单价；但仍可能存在 **名称对不上、用户明知应对哪条 feed 模型** 的个案，需要一条不复活「私有价目表」的补救路径。

[按模型表按定价别名折叠到 modelId](../implemented/2026-09-10-bymodel-folds-pricing-aliases.md) 解决的是 feed 内别名 → modelId 的展示折叠，发生在 **已命中定价** 之后的 `attachCosts` 路径；本问题发生在 **更早的 lookup**，前缀名尚未进入 alias 折叠逻辑。

## Proposal

在插件侧扩展定价查找（不改动本 PR 代码，仅记录方向），优先级建议如下：

1. **精确匹配**（保持现状）：对 feed 展平后的 `modelId` 与 `aliases` 做大小写敏感的完整字符串匹配。
2. **用户本地关联映射**：在数据目录存放仅含 **用量名 → feed modelId** 的映射（非单价、非整表覆盖）；查找时若精确匹配失败，用映射得到 feed 侧 modelId 再查表。映射仅存本机，不进上游 feed，也不写入 npm 包。
3. **归一化匹配**：对仍无价的名称，取 **最后一个 `/` 之后的子串** 作为候选键，再对 feed 的 modelId/aliases **大小写不敏感** 匹配（与 strip 前缀决策配套的自然行为）。
4. **仍失败 → 未定价**：UI 保留未定价警示，并增加引导（文案/链接）跳转 [model-price-table Issues](https://github.com/LaoYueHanNi/model-price-table/issues)，鼓励用户向上游补价或补别名，而非在本地养私有价。

边界与既有决策对齐：

- 本地文件 **只存名称关联**，不恢复 [废除手工 pricing.json](../implemented/2026-09-05-abolish-manual-pricing-json.md) 所废除的自定义 `unitPrice` / 整模型覆盖；关联指向的仍是 feed 里已有条目及其 `timeRules` / `contextTiers` / `dailySlots`。
- feed 内 aliases 折叠与 byModel 展示仍按 [按模型表按定价别名折叠](../implemented/2026-09-10-bymodel-folds-pricing-aliases.md) 执行；本 DR 的 normalize + 本地映射发生在进入 `cloudToTable` 命中逻辑之前或与之衔接的 lookup 层。
- 优先在插件内修 lookup，而非要求上游为每个提供商前缀重复维护 alias。

## Alternatives considered

- **在上游 model-price-table 为每个 `provider/model` 写满 aliases** —— 理论上精确匹配即可命中，但组合爆炸、多 fork/多区域重复劳动，且把「网关命名习惯」耦合进定价表维护。输了：维护面在上游扩散，与本项目「补缺走 issue/PR、表保持短官方 id」更一致的做法是在消费端归一化。
- **恢复完整本地 `pricing.json` 手工价目覆盖** —— 用户可本地写价立刻止血，但复活已废除的双来源合并、整模型覆盖语义与无 UI 私有价反模式（见 [废除手工 pricing.json](../implemented/2026-09-05-abolish-manual-pricing-json.md)）。输了：与 2026-09-05 决策冲突；正解是上游补价 + 本地仅做名→id 关联。
- **仅正则/启发式匹配、不做本地映射** —— 实现更轻，但对非标准命名、内部代号、与 feed 完全异名的模型仍无解；strip `/` 后缀也无法覆盖「同名不同价」需人工指认的场景。输了：无法覆盖 issue 里「用户知道应对哪条 feed 模型」的个案。
- **仅本地用户映射、不做自动 strip** —— 避免错误归一化带来的误匹配，但每个带前缀的模型都要用户手配，issue 中的典型 `z-ai/GLM-5.3` 类问题零配置仍无法解决。输了：自动取 `/` 后段是低成本、可预期的默认行为，应与映射并存而非二选一。

## Acceptance criteria

落地后（本 DR 实施时）应可观察到：

- 对 issue 示例类名称（如 `z-ai/GLM-5.3`、`openai/gpt-6-astra`、`deepseek/deepseek-v4.1-flash`），在 feed 已有对应短 id/别名时，经 **取最后一个 `/` 后段 + 大小写不敏感匹配** 可命中定价，不再误报未定价。
- 用户配置的 **本地关联映射** 在重启与数据目录迁移后仍生效；映射只改变 lookup 用的 feed modelId，**不出现**本地自定义单价字段或整表覆盖行为。
- 仍无法命中的模型：UI 展示未定价状态，并提供指向 model-price-table Issues 的明确入口（如 `https://github.com/LaoYueHanNi/model-price-table/issues`）。
- 查找优先级符合 Proposal 所列 1→2→3→4；与 [别名折叠](../implemented/2026-09-10-bymodel-folds-pricing-aliases.md) 无双重计数或行名错乱。
- `node docs/decisions/check.mjs` 通过；相关测试覆盖 normalize、映射与未定价 UI 引导（实施提交时）。

## Risks

- **误匹配**：不同提供商在 `/` 后使用相同短名时，归一化可能挂到错误价目；需用精确匹配与本地映射优先、并在文档中说明冲突时依赖用户映射纠正。
- **本地映射与 feed 漂移**：上游重命名或删除 modelId 后，旧映射可能指向失效 id，表现为未定价或错价；需要 UI 或校验提示用户更新映射，而非静默回退到自定义价。
- **与废除手工定价的边界被误解**：用户或文档若把「关联文件」当成第二套价表，会重演 2026-09-05 已否决的路径；实施时须在类型、文件名与文档中强调 **association ≠ price override**。
- **大小写不敏感匹配的碰撞**：feed 中若存在仅大小写不同的两个键（少见），_insensitive 合并可能_ambiguous；实现时需定义确定性规则（例如仍优先精确匹配、再 normalize）。
