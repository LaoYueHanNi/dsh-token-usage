# DR: 升级辅助请求分类至 LlmRequestPurposeMap 并支持 timeline-report 与 auto-review 会话归属

Status: implemented

## Problem

DSH `0.2.2`（`LlmRequestPurposeMap`）在 `@deepseek-ai/dsh-llm` 中引入可扩展的辅助请求用途声明机制，全仓正式声明了 `'compaction'`、`'session-title'`、`'auto-review'` 与 `'timeline-report'` 四类 `purpose`（仅 `@deepseek-ai/dsh-experimental-translator` 仍不带 `purpose` 与 `sessionId`），且新版 `auto-review` 与会话级 `timeline-report` 均在请求上直接携带了真实 `sessionId`。

本插件此前存在三处缺口：

1. [aux-request.ts](../../../src/aux-request.ts) 仅识别 `'compaction'` 与 `'session-title'` 两个 `purpose`，`auto-review` 仅靠 `REVIEW_POLICY` 系统提示词前缀匹配，`timeline-report` 因同时带 `sessionId` 且无明确 `purpose` 分支，若无 `purpose` 拦截会被当成普通对话请求跳过，若不带 `sessionId` 则落入 `other` 兜底桶，无法在「运行开销」与请求池中独立展示。
2. [request-observe.ts](../../../src/request-observe.ts) 内联硬编码了一套比 `classifyAuxRequest()` 更窄的判断逻辑，不识别 `purpose: 'auto-review'`、`timeline-report` 或未知 `purpose`：一旦这类请求带着 `sessionId` 经过 `llm/stream`，`RequestObserver` 会把它误判为普通 `request` 行，导致 `linkAuxAttempt()` 匹配失败而在请求池出现双行，并错误触发「缓存过低」告警。
3. 本插件的 `devDependencies` 仍以 DSH `0.2.1-rc.3` 类型为基线（其中 `GenerateOptions.purpose` 为窄联合 `'compaction' | 'session-title'`，且 `0.2.2+` 的 `LlmRequestPurposeMap` 也只在导入对应实验包时才合并键），直接比对新 `purpose` 字面量会触发类型不重叠编译错误。

## Decision

1. **扩展 `AuxKind` 并补全中英文展示文案**：
   - [usage-record.ts](../../../src/usage-record.ts) 在 `AuxKind` 与 `AUX_KINDS` 中新增 `'timeline-report'`（顺序为 `'auto-review' | 'session-title' | 'timeline-report' | 'translation' | 'other'`）；`parseRecord` / `coerceRecord`、[rollup.ts](../../../src/rollup.ts) 与 [stats.ts](../../../src/stats.ts) 基于 `AUX_KINDS` 自动接纳并聚合该类别。
   - [locales.ts](../../../src/client/locales.ts) 补充 `aux.kind.timeline-report`（`时间线报告` / `Timeline reports`）与 `pool.kind.timeline-report`（`时间线` / `Timeline`），在「运行开销」分组、开销胶囊悬停提示与请求池模型徽标中独立呈现。
2. **在 [aux-request.ts](../../../src/aux-request.ts) 优先按 `LlmRequestPurposeMap` 分类**：
   - 通过 `const purpose: string | undefined = options.purpose` 展宽来自 DSH 类型定义的窄字面量或可选扩展键，无需 `as` 断言即可同时兼容 `0.2.1-rc.3` 与 `0.2.2+`。
   - 分类顺序：`compaction` 排除（由 `compaction/summary` 记账）→ `session-title` → `auto-review` → `timeline-report` → 其余非 `undefined` 的未知 `purpose` 直接归入 `'other'`（因为普通对话请求不携带 `purpose`，避免未来宿主新增带 `sessionId` 的辅助用途时被主对话分支静默丢弃）→ 保留 `REVIEW_POLICY` 前缀识别兼容旧宿主 → 带 `sessionId` 且无 `purpose` 视为普通对话请求跳过 → `TRANSLATION_PROMPT_PREFIX` 识别翻译 → `'other'` 兜底。
3. **统一实时观察器与持久记录器的分类来源，落实 `auto-review` 与 `timeline-report` 会话归属**：
   - [request-observe.ts](../../../src/request-observe.ts) 的 `attachLlm` 与 `observe` 直接接收 `GenerateOptions` 并复用 `classifyAuxRequest(options)`（仅先跳过无 `sessionId` 的全局辅助请求，再对 `purpose === 'compaction'` 走 `'compaction'` 分支），彻底消除两条监听器各自维护分类逻辑造成的双行与误告警风险。
   - [src/index.ts](../../../src/index.ts) 的 `llm/stream` 旁路监听器对非空 `sessionId` 的 `auto-review` 与 `timeline-report` 保留 `sessionId` 落盘并调用 `requestObserver.linkAuxAttempt()` 链接；统计聚合（[stats.ts](../../../src/stats.ts)）与 `reconcileDayFiles()` 既有归属规则自动将其纳入对应会话用量、请求池与全量对账豁免。

## Alternatives considered

- **直接升级插件所有 `@deepseek-ai/dsh-*` 依赖到 `0.2.2-rc.5` 并通过导入实验包声明扩展 `LlmRequestPurposeMap`** —— 放弃：即使在 `0.2.2+` 中，`@deepseek-ai/dsh-llm` 的 `LlmRequestPurposeMap` 本身也是空接口，需要实际导入实验包 `auto-review` / `timeline` 才会合并键，而本插件不应强依赖可选实验包；此外当前路由/基线尚分批推进，展宽为 `string | undefined` 对所有宿主版本零成本兼容。
- **把带未知 `purpose` 且带 `sessionId` 的请求交由 `if (options.sessionId !== undefined) return undefined` 跳过** —— 放弃：DSH 契约规定普通对话请求绝不设置 `purpose`（`agent-loop` 不传，仅辅助调用声明），若把未知 `purpose` 当成主对话跳过，会导致宿主未来新增旁路用途时彻底漏记（因为辅助调用也不会产生 `assistant/message`）。
- **在 [request-observe.ts](../../../src/request-observe.ts) 保留独立的 `if/else` 分类判断** —— 放弃：与 [aux-request.ts](../../../src/aux-request.ts) 逻辑重复且已实际发生漏同步（不认 `purpose: 'auto-review'`），复用 `classifyAuxRequest()` 可单点保证两端严格一致。

## Consequences

- 代价：升级前旧版宿主或旧版插件下无明确分类而落入 `auxKind: 'other'` 的历史时间线报告 JSONL 行保持原样，只对升级后的新请求按 `'timeline-report'` 单独拆行；若未来 DSH 出现既带 `purpose` 又写 `assistant/message` 的非标准调用，需要在此白名单排除（当前 DSH 架构明确禁止此用法）。
- 换来：`auto-review` 与 `timeline-report` 不再依赖提示词脆弱匹配，带 `sessionId` 的调用准确归入会话总计、请求池与「运行开销」独立分类，且 `RequestObserver` 与持久记录器严格单源分类、不产生重复行。
