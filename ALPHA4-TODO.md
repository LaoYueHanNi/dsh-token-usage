# ALPHA4 跟进工单（临时文件）

> **临时性约定**：本文件是宿主 dsh 0.1.2-alpha.4 的迁移工单，由对照分析生成（分析基线见文末）。
> **开发 agent 完成下列全部事项后，删除本文件**（随迁移提交一起 `git rm` 即可，无需保留历史说明）。
> 本文件所在提交（临时提交）仅承载此工单，不包含任何代码改动。

## 背景

- 宿主 deepseek-harness 发布 `0.1.2-alpha.4`（npm `alpha` dist-tag；`dsh-v0.1.2-alpha.3..dsh-v0.1.2-alpha.4` 区间 297 提交）。
- 变更报告：`E:\Documents\MyCode\deepseek-harness\alpha4-changes-report.md`。
- 本插件当前分支 `feature/0.1.2-alpha.3` 基于 alpha.3（`0.3.12-dsh-0.1.2-alpha.3`）。
- 对照结论：**src/ 生产代码无踩点**，改动集中在依赖对齐与 tests/ 的 branded 类型适配。

## 必改清单（按执行顺序）

### 1. 测试代码 branded 类型适配（唯一编译必坏点在此）

宿主 alpha.4 引入 `SessionSeq` / `SessionLogOffset`（`BrandedNumber = number & { readonly [BRAND]: B }`，
来源 `packages/core/session/src/types.ts`，提交 `27bf1039db`）。`SessionEvent.seq` 类型从 `number`
变为 branded `SessionSeq`，普通 number **不能**直接赋值。

1.1 **必坏点**（typecheck 必报错）——`tests/integration.spec.ts:234` 附近，全文件 17 处
`emit('session/event', ...)` 中唯一的裸字面量：

```ts
ctx!.emit('session/event', { id: 's1' }, {
  type: 'turn/start',
  seq: 0,          // ← number 赋给 branded SessionSeq，编译报错
  time: 1,
  data: { turn: 1 },
})
```

修法：`seq: 0` → `seq: SessionSeq(0)`，并 `import { SessionSeq } from '@deepseek-ai/dsh-session'`。

1.2 **侥幸合法、顺手清理**——以下 mock 把普通 number 冒充 branded 值，靠 `as` 断言的
"任一方向可赋值"规则编译通过（`SessionSeq → number` 方向成立）。升级时改用宿主构造器，
消除语义噪音：

- `tests/helpers.ts:16`：`seq: overrides.seq ?? 1` + `as SessionEvent<'assistant/message'>`
  → `seq: SessionSeq(overrides.seq ?? 1)`（overrides 参数类型 `seq?: number` 可保留，
  构造器会做非负安全整数校验）
- `tests/quota-integration.spec.ts:172`（`contextEvent`）：`seq: 1` → `SessionSeq(1)`
- `tests/sync.spec.ts:45,47`：两处 `{ type: 'turn/start'|'assistant/chunk', seq: N, ... } as SessionEvent`
  → seq 改走 `SessionSeq(N)`（若 type 字面量推断仍不匹配联合，保留 `as`，仅 branded 值需真构造）

注意：`tests/usage-record.spec.ts:112` 的 `seq: 42` 是 legacy JSONL 行"额外字段被忽略"的用例，
与宿主类型无关，**不要动**。

### 2. 依赖对齐

- `devDependencies` 全部 18 个 `@deepseek-ai/*` 宿主包：`^0.1.2-alpha.3` → `^0.1.2-alpha.4`
  （dsh-credentials、dsh-settings、dsh-api-session-controller、dsh-client-connection、
  dsh-client-locale、dsh-client-store、dsh-client-ui-conversation、dsh-client-ui-primitives、
  dsh-client-ui-renderer、dsh-client-ui-session、dsh-client-ui-settings、
  dsh-client-ui-settings-plugins、dsh-client-ui-slots、dsh-host-webserver、dsh-llm、
  dsh-session、dsh-session-persistence、dsh-session-stats）
- `peerDependencies`：`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-settings` 同步 → `^0.1.2-alpha.4`
  （`@deepseek-ai/schemastery` 不动）
- 重刷 lock（项目同时存在 package-lock.json 与 pnpm-lock.yaml，按当前发布实际使用的那个刷）

### 3. 版本号

- `package.json` `version`：`0.3.12-dsh-0.1.2-alpha.3` → `0.3.13-dsh-0.1.2-alpha.4`
  （延续 prerelease 标签点名目标宿主的约定，见 `docs/decisions/implemented/2026-09-01-migrate-to-dsh-0-1-2-alpha-3.md`）

### 4. 全量回归（跑在 alpha.4 真实类型上）

```bash
npm run typecheck
npm run test
npm run build && npm run build:client
```

- 5 个 client spec（usage-view / quota-button / session-stats-chip / token-usage-card /
  token-usage-section）的 mock kit 若有其他 branded 边界报错，按 1.1 同法处理
- 在 alpha.4 宿主上冒烟：Usage 视图 tab、Quota 按钮、settings 卡片、目录迁移与 full sync

### 5. 决策记录（AGENTS.md 规范，与迁移代码同一提交）

- 新增 `docs/decisions/implemented/2026-09-XX-migrate-to-dsh-0-1-2-alpha-4.md`
  （日期以实际提交为准），沿用 alpha.3 迁移记录的三路比对格式
- 核心结论可直接引用本文件第 6 节的免改对照表

### 6. 发布

- `npm publish --tag dsh-alpha`（prerelease 不占 latest，通道约定同上）

## 已验证免改对照表（防止重复分析）

| 插件消费的宿主 API | alpha.4 变化 | 结论 |
|---|---|---|
| `SessionEventMap['assistant/message']` / `['request/context']` data（usage、message.id、message.source.model/provider） | 逐字未变 | 免改 |
| `sessionPersistence.list()` / `.inspect()`（src/sync.ts duck-type） | 签名未变；`SessionInspection` 新增只读 `inheritedEventCount` | 免改（只增字段） |
| `SessionHeader.seedLength` → `isSeeded` 必填 | 插件只读 `list()` 返回的 id，不消费 header | 免改 |
| persistence backend 面（`SessionStorageMetadata`/`SessionEventSuffix`、create/readFrom/appendBatch/commitRepair 签名） | 大改 | 插件不实现 backend，免改 |
| `SessionEvent.seq` branded 化 | src/ 从不读 seq；仅 tests/ 踩边界 | 见必改 1 |
| client contract `rename().seq` / `loadThrough(seq)` branded 化 | 插件不调用 | 免改 |
| `SessionListState` / `UseProjection`（api-session-controller/client） | `SessionListState` 逐字一致；`UseProjection` 未变 | 免改 |
| `ProjectionsBaseline.asOfSeq` branded 化 | 插件只读 `projectionValues.sessionStats`，不读 asOfSeq | 免改 |
| `SessionStatsProjection`（session-stats 包） | 仅删 invariant.ts | 免改 |
| ui-slots / ui-renderer | 纯新增 `keyedHooks`（`hooks` 路径保留） | 免改 |
| ui-settings / ui-settings-plugins / ui-session / ui-primitives / ui-model-selection | 仅 CSS + 删 invariant.ts；`Tooltip`/`SettingsScope`/`SettingsSectionOwnerProps`/`modelDirectories` 契约未动 | 免改 |
| ui-conversation contract（conversation.ts / slots.ts） | Location keyed source、`materialize` 加 previous 参；输入区 slot 移除 `owner: InputZone`、InputBar props slot 化 | 插件是 slot entry 注册方，props 面未动，免改 |
| settings `installSection` / llm `listConfigurableProviders` / `TokenUsage` / credentials / host-webserver | src 无变化 | 免改 |
| 磁盘格式 `SESSION_FORMAT_VERSION` | 仍为 0 | 免改 |
| steer 统一（#4）/ web fetch 默认开放（#5）/ Python runtime（#3） | 不在插件消费面 | 免改 |

## 运行时风险

无。`brandNumber` 只是类型层品牌，插件不向宿主传 branded 值；宿主 `SessionSeq()` 校验仅在
宿主自身调用路径触发。

## 分析基线

- 宿主仓库：`E:\Documents\MyCode\deepseek-harness`（tag `dsh-v0.1.2-alpha.3` / `dsh-v0.1.2-alpha.4`）
- 变更报告：`alpha4-changes-report.md`（同仓库根）
- 上轮迁移决策：`docs/decisions/implemented/2026-09-01-migrate-to-dsh-0-1-2-alpha-3.md`
- 分析日期：2026-09-02（对照本分支 HEAD `a50874d`）
