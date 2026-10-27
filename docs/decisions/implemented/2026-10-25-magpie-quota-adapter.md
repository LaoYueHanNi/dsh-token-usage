# DR: Magpie 网关配额适配器（探测识别 + 按模型限定卡片）

Status: implemented

## Problem

magpie 网关（默认 `127.0.0.1:3425`）把用户全部上游供应商的配额与余额汇总成「配额卡」，通过只读的 `GET /v1/magpie/quotas` 暴露。但 DSH 里使用 magpie 的姿势是一个用户自声明的 OpenAI 兼容 provider：路由键任意（`my-gateway`）、baseURL 指向回环或局域网地址——现有适配器的两类匹配信号（catalog 路由键、已知厂商 host 表）都无法覆盖，配额按钮对这些用户永远隐藏（`unsupported`）。且一个 magpie 路由背后是**多家**上游供应商的卡片，还需要按当前会话选用的模型限定到相关供应商（模型 id 是 `provider/model`，路由组是 `group/…`）。

## Decision

> [!NOTE]
> 本决策中的实时配额读取与仅从请求记录获取模型的设计，已于 2026-10-25 由 [DR: Magpie 缓存读取与实时模型选择](2026-10-25-magpie-kept-live-selection.md) 取代。探测、配额归一化与分组规则仍然有效。

新增 `src/quota/adapters/magpie.ts`，分两层接入：

1. **探测识别**：magpie 对 `GET /` 与 `GET /v1` 回答 `{"name":"magpie",…}` hello（它为 Empryo 等客户端的特征探测专门维护）。`MagpieDetector` 在 QuotaService 里于注册表落空**之后**兜底调用（带 key、5s 超时），正负结果分别缓存 10 分钟 / 2 分钟——面板对 `unsupported` 的周期轮询不会打爆探测。注册表内 magpie 只认领显式路由键 `magpie`（无 profile 时回退默认地址 `http://127.0.0.1:3425/v1`），回环 host **不**作为匹配信号（LM Studio、Ollama 等同住回环）。
2. **查询与归一化**：`GET {base}/v1/magpie/quotas`（baseURL 两种拼写都归一；Bearer 可选——回环网关免 key，`usesApiKey: false`，远程共享网关缺 key 时以 auth 错误浮出而非按钮隐藏）。`queryTimeoutMs` 提到 15s：网关侧自带 12s 并发询问死线，客户端默认 10s 会先把中继掐死。卡片归一化：周期名（`5 hours` / `Weekly` / `7 days`…）映射既有 tier；开放窗口名（`Credits`、`Allowance`）以新增的 `QuotaTier: 'other'` + `QuotaWindow.name`（厂商原名）透传；`balance` 字符串取第一段带符号金额（`¥`→cny、`$`→usd，无符号数字拒绝——网关同样格式化 `12.3k credits` 类非货币计数）；失败卡片丢弃、全失败上抛；卡片标题（`Name · Plan[ · User]`，同供应商多账号时限定）写入新增的 `QuotaWindow.card`，面板按卡片分组渲染。
3. **模型限定**：`ProviderSighting`（含 model）经 `resolveCurrentSighting` 直达 `QuotaQueryContext.model`；缓存与 in-flight 键从 provider 扩为 provider+model。模型前缀命中卡片集合时只显示该供应商（多账号全显）；`group/` 前缀、裸 id、前缀无卡时回退全舰队卡片——组成员是用户随时编排的、REST 不列出的，全量是网关存在的意义本身。

> [!NOTE]
> 卡片窗口另带 `QuotaWindow.pool`（额度池标识，同供应商多 key 共享一个池），供触发器按池聚合水位——见 [DR: 配额触发器按额度池聚合](../implemented/2026-10-27-quota-trigger-pool-aggregation.md)。

## Alternatives considered

- **host 表匹配（把 `127.0.0.1:3425` 等端口写进 matches）** —— 输在把「回环 + 端口」当成 magpie 专属：端口可改（`MAGPIE_ADDR`），且回环上住着 LM Studio、Ollama 等一堆邻居，误命中会把别家的 baseURL 打上 magpie 配额路径。hello 探测是网关作者自己维护的正向信号。
- **`?kept=1` 优先、空缓存再实查** —— 输在首启（从未读过配额）永远拿到空缓存，还得二次请求；而网关自身已内建节流（「仅被问时读取」设置下 `GET /v1/magpie/quotas` 自动返回上次读数），客户端无需再叠一层 kept 逻辑。
- **用 `/v1/magpie/route?session=` 拿实际路由供应商** —— 输在 DSH 会话 id 与网关会话 id 不同源，且 route 只报最近一次请求的落点，模型刚切换还没发请求时拿不到任何东西；模型 id 前缀是每次请求都携带的稳定信号。
- **为路由组枚举成员（调 GUI 私有接口或 heuristics 猜）** —— 输在网关没有公开组成员的 REST 端点，GUI 接口不是稳定契约；auto 组还跟随目录动态变化。全舰队卡片（分好组、带标题）对「这个组还剩多少」本就是正确答案。

## Consequences

- 代价：未知路由的首次配额请求多一跳 hello（缓存后归零）；`other` tier 使 `QuotaTier` 枚举扩容，面板 tier 标签表与排序表各加一行；多卡 payload 面板按卡片分组、始终用 320px 全宽板。
- 换来：magpie 用户（任意自定义路由名）零配置获得配额按钮——探测自动识别；按当前模型只看相关供应商的卡片，路由组看到全部上游的分栏；每张卡的窗口名、余额币种、多账号标识都保留厂商原意；探测、超时、缓存全部可注入可测（服务层 18 例 + 适配器 61 例测试覆盖）。
