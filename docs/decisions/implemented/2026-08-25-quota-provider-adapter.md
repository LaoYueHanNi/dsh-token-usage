# DR: 供应商配额的适配器契约（QuotaAdapter）

Status: implemented

## Problem

「输入栏配额按钮」需要按**当前会话正在使用的供应商**查询并展示套餐配额（5 小时 / 周 / 余额）。dsh 底层经 pi-ai 枚举大部分供应商（路由 id 形如 `zai-coding-cn`、`minimax`，也允许用户自定义路由名），各家配额端点的协议差异极大：智谱的 `Authorization` 头**不带 Bearer 前缀**、窗口靠 `unit` 字段分类；Kimi 可能同时存在多个 5 小时滚动桶；MiniMax 给的是**剩余**百分比且业务错误走 HTTP 200；DeepSeek / OpenRouter 则是纯余额语义。cc-switch 的调研（`PROVIDER_USAGE_RESEARCH.md`）把这类差异归一成「tier + 窗口」模型，其五路分发 + 每家一个 `query_xxx()` 的结构已被验证。

## Decision

1. **一条适配器接口**（`src/quota/types.ts`）：

   ```ts
   interface QuotaAdapter {
     id: string                                   // 诊断用稳定 id
     label: string                                // 家族显示名（诊断 + host 命中时的限定后缀）
     routes?: readonly string[]                   // 自有的目录路由 key；未列出却命中的 = host 匹配的自定义路由
     matches(input: { provider; baseUrl? }): boolean   // host 优先，路由 id 次之
     query(ctx): Promise<{ windows: QuotaWindow[]; planTier?: string }>
   }
   ```

   适配器只负责「认领路由 + 归一化响应」；传输（`fetchJson`，含错误归一化 auth/http/network/parse）、身份元数据（provider/displayName/fetchedAt/intervalSec）与缓存一律由公共层（`quota-service.ts`）承担。

   2. **匹配规则：base URL host 优先于路由 id。** 用户自定义的 pi-ai 路由可以叫任何名字但指向已知端点（host 是稳定信号）；反过来路由 id 也可能歧义——pi-ai 的 `moonshotai` 指标准 Moonshot API 而非 Kimi For Coding，因此 kimi 适配器按 host 或明确的 catalog 路由 `kimi-coding` 匹配（**不**匹配 `moonshotai`）。OpenCode Go 同理：只认 `opencode-go` 与路径含 `/zen/go` 的端点，**不**匹配 Zen 按量路由 `opencode`。profile 省略 `baseURL` 时由 `CATALOG_BASE_URLS` 填 catalog 默认端点（智谱两站、`kimi-coding`、`minimax` / `minimax-cn`、`opencode-go`），host 匹配与 MiniMax 选站才站得住。host 命中而路由 key 不在适配器 `routes` 列表内时（自定义路由），service 把显示名组合为「别名 · 适配器家族名」——配额归属于实际命中的家族，别名（如把 OpenCode Go 端点命名为 OpenAI）不得冒名（见 [host 命中路由的显示名](2026-08-26-quota-host-matched-display-name.md)）。

   3. **窗口词汇表在 wire 层共享**（`QuotaTier = five_hour | weekly | monthly | balance`），前端按 tier 自适应展示（进度条 vs 金额），双方向百分比（已用 / 剩余）与余额绝对值（`remainingValue`/`maxValue`）都允许，由 `quota-format.ts` 统一推导。

   4. **凭据零配置**：查询用与推理同一把 key，按 `llm 供应目录（`listConfigurableProviders`，缺席回退内置映射）→ 供应商标签页（沿 `settingsPath` 走 `ctx.settings.get`）→ `apiKeyEnv` 引用 → `credentials.resolve` → `llm-pi-ai/<route>` 记录存储（特性检测）→ 进程环境变量` 的链解析（`credentials.ts`）。全部在 node 侧完成，浏览器永远接触不到密钥（浏览器的 settings 镜像本身也拿不到值）。

   5. **当前供应商的判定**（`provider-tracking.ts` + 路由的 `provider` 参数）：浏览器优先把 **model chip 的实时选择**作为 `provider` 参数传给配额路由（来自宿主 `ctx.modelDirectories` 服务上报的下一次请求选择——选中即生效，无需先发消息；经可选注入 + 结构化类型读取，不产生跨插件值导入）；chip 不可用时（服务缺席 / 子会话 / 未加载）回退 `request/context` 与 `assistant/message` 喂入的内存 session→provider 表，再回退 `agent-default-model` 设置。不持久化——配额只关心「现在」。

   6. **缓存与节流**：ok 结果按 provider 缓存 45 s、in-flight 合并；error 不缓存（面板「重试」/打开刷新必须真正外呼）。`no-provider` / `unsupported` 是纯内存判定不缓存。轮询周期由服务端下发给前端（payload 里的 `intervalSec`）。

## 新增一家供应商的标准步骤

1. `src/quota/adapters/<name>.ts` 新建适配器（`matches` 先查 host 再查路由 id；`query` 用 `fetchJson` + fixture 单测）；
2. `src/quota/registry.ts` 的 `QUOTA_ADAPTERS` 加一行；
3. 若需要额外凭据（AK/SK、组织 id 等）或该路由无 `baseURL` 覆盖时可推导 host，扩展 `credentials.ts` 的内置映射；
4. 适配器单测（fixture JSON + 请求头断言）补进 `tests/quota-adapters.spec.ts`。

## Alternatives considered

- **无（成稿时未系统记录备选方案的对比）** —— 关键取舍（host 优先于路由 id 的匹配规则、凭据解析链的回退顺序、error 不缓存的策略）已内联在 Decision 各条款中。

## Consequences

- 每家供应商的差异被压缩在一个文件里，公共层（缓存 / 错误 / 凭据 / 路由）对所有家共享。
- 明确留待扩展位：火山方舟（SigV4 签名 + 独立 AK/SK）、ZenMux（独立的用量查询 base URL）、智谱团队版（`bigmodel-organization` / `bigmodel-project` 头）、官方订阅 OAuth 族（Claude / Codex / Gemini / Grok）。它们需要的额外凭据形态不破坏现有 `matches`/`query` 契约，只需在凭据解析链上加层。
- 供应商目录 / settings / credentials 三个缝隙都以可选注入实现，宿主缺任一服务时链条缩短而非报错（集成测试覆盖了三种凭据来源与全部回退路径）。
