# DR: 废除手工 pricing.json 定价文件机制

Status: proposed

## Problem

定价数据有两个来源：启动自动拉取的云端镜像 `pricing.ccsa.json`，和用户手工放在数据目录的 `pricing.json`（读取时合并，手工条目整模型优先，`src/pricing.ts` 的 `readPricingTable`）。云端来源有完整的维护链路——启动/切区自动同步、Web 设置里有区域下拉、价格错误去上游 model-price-table 仓库改、fork 维护者还能用 `pricingUrl*` 指向自维护 feed。手工文件则是唯一没有任何 UI 入口的维护路径：用户必须自己找到数据目录（默认 `~/.dsh/token-usage/`，配置 `path` 时另算）、凭空知道文件名与格式（只写在深度文档 [docs/pricing.md](../../../docs/pricing.md) 里）、手写 JSON。事实上不可发现的机制近似无人使用（本机数据目录并无此文件），却持续产生成本：

- 合并语义复杂且有破坏性：手工条目**整模型覆盖**，云端该模型的 `timeRules`/`contextTiers`/`dailySlots` 全部丢弃、只剩 base 价——用户想改一个数字却悄悄关掉了峰谷与档位计费。
- 双来源贯穿全部定价代码与文档：`readPricingTable` 的合并段、migrate 的自有文件模式、两组测试、docs/pricing.md 与双语 README 的专门章节。
- [定价表总览提案](2026-09-05-pricing-table-overview.md)还要再兼容它一处：后端返回「云端模型 ∪ 手工条目」、空态文案指路 `pricing.json`。
- 模型价格缺失或错误的正确修法是向上游 feed 仓库提 PR（全部同源用户受益），而不是每个用户本地养一份私有价。

## Proposal

废除手工 `pricing.json` 机制，定价表只认云端镜像：

1. **读取简化**：`readPricingTable` 删除手工合并段，等价于仅 `readSyncedPricing`；随之删除仅服务手工格式的 `PRICING_FILE`、`readManualPricing`、`coercePricingTable`、`isModelPricing`（若云端路径无其他引用）。`stats-route.ts`、`attachCosts`、client 展示层不动。
2. **迁移不删用户文件**：`src/migrate.ts` 的 `OWNED_PATTERNS` 保留 `/^pricing\.json$/`——遗留文件照常随数据目录搬迁，只是从此被忽略。不主动删除用户磁盘上的数据。
3. **测试清理**：删除 `tests/pricing.spec.ts` 的手工覆盖合并用例、`tests/stats-route.spec.ts` 的手工叠加进路由响应用例。
4. **文档清理**：docs/pricing.md 的两文件来源表、覆盖语义段、「pricing.json 扁平格式」一节；双语 README「模型定价」节的手工文件部分。补一句升级说明：已维护 `pricing.json` 的用户升级后该文件被忽略。
5. **联动提案修订**：定价表总览提案改为纯云端来源——后端去掉「∪ 手工条目」、空态文案改为指路「同步定价 / 检查定价区域」而非手工文件；该修订随废除落地同一提交完成。

## Alternatives considered

- **保留现状** —— 代码成本已沉没、改动为零，但双来源的复杂度是持续税：每处定价相关改动（含总览提案）都要多想一条分支，文档要多讲一套合并语义，而它没有 UI 入口、事实上不可发现，收益趋近于无。输了：死代码的维护成本高于删除成本。
- **给 pricing.json 做页面维护入口**（设置页加价格编辑表单，读写手工文件）—— 补齐可发现性，但实现最重：表单 + 校验 + 写盘 + 与云端合并的展示，且没有解决覆盖语义的破坏性；「补缺/改价」的诉求本应在上游 feed 解决，本地私有价是反模式。输了：成本远超一个近乎无人使用的机制的价值（维护者拍板废除）。
- **收紧覆盖语义**（手工条目只覆盖 base 价、保留云端时间规则与档位）—— 消除「改一个数字悄悄关掉峰谷计费」的陷阱，但「部分覆盖」语义更难解释，实现与文档成本不降反升，且根本问题（无入口、不可发现、无人用）原样保留。输了：修的是最不疼的伤。

## Acceptance criteria

- `readPricingTable` 仅返回云端镜像内容；数据目录存在合法 `pricing.json` 时也不被读取，统计照常出数。
- 删除遗留文件的读取代码与相关测试后，全量测试通过；`node docs/decisions/check.mjs` 通过。
- docs/pricing.md、双语 README 不再描述手工文件，并含升级影响说明；migrate 仍会搬迁该文件（不删除用户数据）。
- 定价表总览提案文本已同步修订为纯云端来源，无残留的手工条目引用。

## Risks

- **失去「禁用某模型云端规则定价」的唯一路径**：手工整模型覆盖是目前唯一能在本地关掉某模型峰谷/档位计费的手段（docs/pricing.md 明说的用途），废除后无直接替代。缓解：进阶需求走已有的 `pricingUrl*` 配置指向自维护 feed fork——那条路本来就能完全控制价格表，且有能力用它的用户不依赖无 UI 的手工文件。
- **云端表缺失/价格滞后时无法本地补价**：相关模型按未定价（¥0）计并有页面警告，不会静默错价；正解是向上游 model-price-table 仓库提 PR，等待期接受 ¥0 计费。
- **已有用户升级后静默失效**：无法证明无人使用（npm 分发过），仅能从本机数据目录无此文件佐证影响极小。须靠升级说明与提交信息把影响讲清；文件不删，用户随时可自行清理。
