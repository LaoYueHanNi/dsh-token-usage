# DR: 迁移宿主 dsh 0.1.2-alpha.5（SessionSeq 品牌化 + Session.events 收敛为 snapshotEvents）

Status: implemented

## Problem

宿主 deepseek-harness 发布 0.1.2-alpha.5（npm `alpha` dist-tag；alpha.3→alpha.5 区间 303 个提交，其中 alpha.4→alpha.5 仅 6 个，全部落在 storage 跨版本读兼容与 session-projection-cache 内部层，不在本插件消费面上）。alpha.3→alpha.4 区间的已知断代（对照分析底稿 ALPHA4-TODO.md）对插件的实际影响有两处：其一，`SessionEvent.seq` 从 `number` 品牌化为 `SessionSeq`（`BrandedNumber`，构造器做非负安全整数校验），tests 中以普通 number 冒充 branded 值的 mock 踩编译边界；其二，底稿预判"src/ 生产代码无踩点"在 alpha.5 真实类型下暴露一处漏判——`Session.events` getter（alpha.3 缓存快照语义）被 private 化，替代面是 `snapshotEvents()` / `ownEvents()` / `eventAt(seq)` 方法族，插件 `countInteractingSessions(ctx.sessions.list())` 三处调用点直接编译失败。其余消费面经三路 diff 复核免改：`SessionEventMap['assistant/message']`（usage/message.source 逐字未变）、`sessionPersistence.list()/inspect()`（`SessionInspection` 仅 extends 新 `SessionStorageMetadata`，只增字段）、settings `installSection`、ui-slots/ui-settings-plugins 等客户端注册面在 alpha.4→alpha.5 区间零代码变更。

## Decision

一次提交从 alpha.3 兼容态直迁 alpha.5（alpha.4 无中间发布的必要，见备选）：

1. **tests branded 适配**：`tests/helpers.ts`、`tests/quota-integration.spec.ts`、`tests/sync.spec.ts`、`tests/integration.spec.ts` 里构造 session 事件的 `seq` 字面量改走 `SessionSeq()` 构造器（`overrides.seq?: number` 参数类型保留，构造器负责校验）；`tests/usage-record.spec.ts:112` 的 `seq: 42` 是 legacy JSONL"额外字段被忽略"用例，与宿主类型无关，不动。
2. **src 唯一踩点**：`countInteractingSessions` 的 duck-type 签名从 `readonly { events: readonly { type }[] }[]` 收窄为 `readonly (readonly { type: string }[])[]`——函数真正需要的只是每个会话的事件类型序列；三处调用点改为 `ctx.sessions.list().map(session => session.snapshotEvents())`（无参调用即全量快照，宿主侧缓存复用，语义与旧 getter 一致）；`tests/integration.spec.ts` 的 MockSessions 同步以 `snapshotEvents()` 暴露事件。
3. **依赖对齐**：18 个 `@deepseek-ai/*` 宿主包（16 devDependencies + 2 peerDependencies）`^0.1.2-alpha.3` → `^0.1.2-alpha.5`；双 lock 并刷（package-lock.json 与 pnpm-lock.yaml，对齐 main 0.3.13 的双 lock 现状；alpha.3 迁移时删 pnpm-lock 的单 lock 口径作废）；version `0.3.12-dsh-0.1.2-alpha.3` → `0.3.13-dsh-0.1.2-alpha.5`（基线取当前 main 的 0.3.13，prerelease 标签点名目标宿主，约定沿用 [alpha.3 迁移](2026-09-01-migrate-to-dsh-0-1-2-alpha-3.md)）。
4. **回归**：typecheck / 496 tests / build / build:client 全量跑在 alpha.5 真实类型与依赖上，全绿。ALPHA4-TODO.md 底稿使命完成，随本提交删除。

## Alternatives considered

- **先按原工单迁 alpha.4、再叠 alpha.5 增量** —— alpha.4→alpha.5 对插件消费的全部 20 个宿主包零代码变更（仅版本号 bump 与 storage 内部读兼容），分两步要刷两轮依赖、跑两轮回归，纯成本无所得；直迁 alpha.5 且 diff 基线覆盖全区间（303 提交）即可。
- **`countInteractingSessions` 保留 `{ events }` duck-type，调用处解包或改走 `eventAt(seq)` 倒序探测** —— `snapshotEvents()` 与旧 getter 的全量快照语义逐字一致（宿主侧同样缓存），解包方案只多一层形状噪声；倒序 `eventAt` 探测依赖"seq 连续"契约做终止条件，比直接拿数组倒扫更绕。收窄签名为事件序列的序列同时让单测的 mock 从 `{ events: [...] }` 退化为裸数组，duck-type 面更小。
- **version 基线沿用 0.3.12（即 `0.3.12-dsh-0.1.2-alpha.5`）** —— alpha.3 兼容分支从 0.3.12 分叉，但 main 已发布 0.3.13；prerelease 低于其分叉点的正式版会让从 0.3.13 降级装 alpha 兼容版的路径呈现"版本回退"，基线取 0.3.13 与 main 的真实进度一致。

## Consequences

- 代价：本分支仅兼容 0.1.2-alpha.5 及以上宿主；`^0.1.2-alpha.5` 的 semver prerelease 语义把可解析范围锁在 0.1.2 元组内，宿主出 0.1.3/0.2.0 时需再次迁移；alpha.4 时代不存在插件中间版，从 alpha.3 兼容版（`0.3.12-dsh-0.1.2-alpha.3`）升级的用户一步跨过两代宿主断代，好在断代面（branded seq、events 收敛）已在本次全部消化。
- 换来：全量回归基线落在 alpha.5 真实类型上；`SessionSeq` 构造器让 tests 的 seq 造值经过宿主同源校验（非负安全整数），坏值在构造即抛而非流入断言；三路 diff 基线更新至 alpha.3→alpha.5 全区间，后续宿主 alpha 迭代的对照起点前移。
