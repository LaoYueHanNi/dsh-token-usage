# dsh-token-usage

dsh 本地插件：按请求粒度持久化模型 token 用量，写入按天分片的 JSONL 文件，并在 Web 设置界面提供「Token 用量」统计页。

仓库：<https://github.com/LaoYueHanNi/dsh-token-usage>

## 功能

- **实时 hook**：每次模型请求成功后（`assistant/message` 会话事件）追加一行，包含请求 id、模型名、四项 token 用量、时间、会话 id。
- **首次启动自动同步一次**：补齐插件安装前已发生的历史请求（`state.json` 标记判定，之后永不自动重复；崩溃重试由请求 id 去重保证幂等）。
- **手动再同步命令**：`/token-usage-sync`（Web 命令面板）随时手动补写，以请求 id 去重，与实时数据不重复。
- **Web 设置统计页**：设置面板（侧栏底部齿轮）新增「Token 用量」页，两行汇总卡片——请求数 / 总 token / 缓存命中率一行，输入 / 输出 / 缓存读 / 缓存写一行——下方是按模型的明细表（一行一个模型：请求数、总 token、命中率与四项 token）；token 数值缩写（低于 1M 用 `K`，1M 起用 `M`，1 亿起用 `B`，`B` = 10 亿、1 亿 = `0.1B`，如 `950K`、`1.5M`、`0.5B`、`3B`），带手动刷新。

## 安装与移除

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
# 或指定仓库 URL：
# dsh plugin --profile web add git+https://github.com/LaoYueHanNi/dsh-token-usage.git
# dsh plugin --profile web add git+ssh://git@github.com/LaoYueHanNi/dsh-token-usage.git
```

包声明了 `dsh.bundle`，`add` 会自动把插件加入该 profile 的层栈，**无需手动编辑任何配置文件**。首次启动会自动执行一次历史补齐（终端打印 `[token-usage] first-run sync: N added, M skipped`），之后纯实时记录。

> Git 依赖通过其 `prepare` 脚本构建（tsc + tsdown），pnpm ≥10 默认拦截 git 依赖的构建脚本：若安装报错，按提示把 `dsh-token-usage` 加入 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 后再执行一次。

### 从本地目录安装（开发调试用）

```sh
dsh plugin --profile web add link:<插件目录绝对路径>
# 示例：dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

`link:` 安装的是符号链接：改完代码执行 `npm run build && npm run build:client` 后重启 `dsh web` 即生效；开发时也可在插件目录跑 `npx tsdown --watch`，Web 端 HMR 会自动重载浏览器插件。

### 更新

```sh
dsh plugin --profile web update dsh-token-usage
```

### 移除

```sh
dsh plugin --profile web remove dsh-token-usage
```

自动从层栈移除并停止加载。数据文件（`$DSH_HOME/token-usage/`）会保留，需要时手动删除。

### 临时挂载（覆盖层，不动 profile）

```sh
dsh web --patch <插件目录>/cordis.yml
# 示例：dsh web --patch D:/plugins/dsh-token-usage/cordis.yml
```

仅当次启动生效。`cordis.yml` 指向 built 产物 `lib/index.js`。此模式只挂载 host 半边（数据记录与命令照常工作）；统计页依赖按包名解析的客户端 bundle，请用上面的 `link:` 安装方式开发 UI。

## 配置

插件条目可带 `config:`（bundle 安装时写在 profile 的 `cordis.patch.yml` 对应条目下，临时挂载时写在 `cordis.yml`）：

```yaml
- insert:
    - id: token-usage
      name: 'dsh-token-usage'
      config:
        path: 'C:/data/token-usage'   # 数据目录；缺省 $DSH_HOME/token-usage（$DSH_HOME 未设时为 ~/.dsh/token-usage）
```

未知配置键在加载时直接报错。

## Web 设置统计页

设置面板（侧栏底部齿轮）里有一个「Token 用量」页，数据来自本插件注册的 HTTP 路由 `GET /token-usage/stats`（不占用 `/api` RPC 方法表——那是宿主封闭的传输层，插件数据通道走自己的 webServer 路由）。页面展示总量汇总：请求数、总 token（四项之和）、缓存命中率（缓存读 ÷（输入 + 缓存读），无数据时显示 `—`）一行，输入 / 输出 / 缓存读 / 缓存写四项 token 桶一行；下方是按模型明细表（一行一个模型，列为请求数、总 token、命中率与四项 token）。token 数值缩写（低于 1M 用 `K`，1M 起用 `M`，1 亿起用 `B`，`B` = 10 亿，即 1 亿 = `0.1B`），缓存命中率保留一位小数。路由返回的 JSON 除总量外仍包含按日聚合和最近 20 条请求，供后续页面扩展使用：

```json
{
  "dataDir": "C:/Users/you/.dsh/token-usage",
  "total": { "requests": 12, "inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 9000, "cacheWriteTokens": 100 },
  "byDay": [{ "day": "2026-01-15", "totals": { "requests": 3, "inputTokens": 200, "outputTokens": 100, "cacheReadTokens": 900, "cacheWriteTokens": 10 } }],
  "byModel": [{ "model": "deepseek-chat", "totals": { "requests": 10, "inputTokens": 800, "outputTokens": 400, "cacheReadTokens": 8000, "cacheWriteTokens": 80 } }],
  "recent": [{ "requestId": "…", "time": 1730000000000, "sessionId": "…", "model": "deepseek-chat", "usage": { "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 900 } }]
}
```

- 路由带 `no-store` 缓存头，页面每次刷新/打开都重新计算（rollup 聚合文件 + 当天 JSONL），无需轮询。
- 非 GET 请求返回 405；浏览器跨站请求（`Sec-Fetch-Site: cross-site`）返回 403，防止陌生网页读取本机用量统计。
- 统计页是浏览器端插件（`dsh.client` 声明 + `lib/client.js` bundle）：web profile 的 client-modules 扫描到本包后自动挂载并注入设置导航，无需改动宿主配置。

## 数据

目录下每个本地日期一个文件：`usage-YYYY-MM-DD.jsonl`，每行一条成功请求：

```json
{
  "requestId": "<assistant message id，去重键>",
  "time": 1730000000000,
  "sessionId": "…",
  "model": "deepseek-chat",
  "usage": {
    "inputTokens": 100,
    "outputTokens": 50,
    "cacheReadTokens": 900,
    "cacheWriteTokens": 10
  }
}
```

- `usage` 只保留四项基础桶；`cacheReadTokens`/`cacheWriteTokens` 在 provider 未报告时**省略**（不写 null）。
- provider 完全未报告用量时整个 `usage` 省略（请求仍记录一行）。
- `inputTokens` 为未缓存输入；计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`。
- 扫描去重时兼容旧字段集的行（多余字段忽略、null 桶归一化为省略），旧行只会被吸收去重，不会被重写。

### rollup 聚合文件（rollup.json）

数据目录里还有一个 `rollup.json`：所有「已冻结」天文件（文件名日期早于今天）的累计聚合结果，含已吸收到的日期上限 `upto`、总量、按日/按模型行和最近窗口。由于写入永远追加到当天文件，已冻结的天文件不可变，rollup 吸收后永不失效：

- **惰性推进**：每次统计读取时发现存在未被吸收的冻结天文件（如昨天的文件），先读入聚合、并入 rollup 并原子写回（临时文件 + 改名），`upto` 推进到最新冻结日期；不需要定时任务。
- **读取成本**：统计页刷新只需读 `rollup.json`（几十 KB 量级）+ 当天 JSONL，不再随历史数据增长变慢。
- **损坏自愈**：`rollup.json` 缺失或损坏时按不存在处理，从天文件全量重建后写回，退化成本等于一次全量读取。
- 手动 `/token-usage-sync` 补写的历史请求同样写入**当天**文件，冻结文件不受影响，rollup 无需失效。

## 同步机制

- **首次启动**（数据目录无 `state.json`）自动执行一次全量同步：扫描数据文件重建去重集合 → 枚举磁盘上全部持久化会话 → 补写缺失请求行；完成后写入标记，之后启动不再自动同步。
- **手动命令**：命令面板执行 `/token-usage-sync`，返回「新增 N 条 / 去重跳过 M 条」。重复执行是幂等的。

## 开发

```sh
npm install
npm run typecheck   # 类型检查（host + client 两侧源码）
npm run test        # vitest 单元 + 集成 + 组件测试
npm run build       # tsc 产出 lib/（host 半边）
npm run build:client # tsdown 产出 lib/client.js（浏览器 bundle）
```

仓库**已提交 `lib/` 构建产物**（`.gitignore` 不忽略），改代码后需重新构建并提交：

```sh
npm run build && npm run build:client
git add -A
git commit -m "your change"
git push
```

`prepare` 脚本（`npm install` 与 git 依赖安装时自动执行）会同时跑两个构建。

### 项目结构

```
src/
  index.ts          # 插件入口：实时 hook + 首次自动同步 + 命令注册 + 统计路由挂载 + Config
  usage-record.ts   # 行类型、事件→记录投影、序列化/解析（纯函数）
  usage-log.ts      # 按天 JSONL 写入队列、请求 id 去重集合、扫描重建
  rollup.ts         # rollup.json 读写：冻结天文件的磁盘聚合（原子写入，损坏安全降级）
  sync.ts           # 同步算法 + 首次自动同步编排
  sync-state.ts     # state.json 初始化标记（原子写入）
  stats.ts          # 统计聚合 + 数据文件读取（host 半边）
  stats-route.ts    # /token-usage/stats 路由（webServer 注册）
  wire.ts           # 浏览器安全的线上词汇：路径常量 + 统计 JSON 类型
  client/
    index.ts              # 浏览器插件入口：注册 settings.section（Token 用量页）
    TokenUsageSection.tsx # 统计页组件（fetch + 汇总渲染 + 刷新）
    TokenUsageSection.module.css
cordis.patch.yml    # bundle 层补丁（dsh plugin add 自动启用）
cordis.yml          # 临时 --patch 覆盖层（file:// URL 形式）
tsdown.config.ts    # 浏览器 bundle 构建（闭包工厂 + 平台 external + CSS Modules 内联）
```

## 语义与限制

- 只记录**成功**请求（有 `assistant/message` 事件）；失败/取消请求和 step 内重试的中间尝试不记录。
- 首次同步标记缺失或损坏时视为未初始化：下一次启动会重跑同步（去重后为无操作），标记以临时文件 + 原子改名写入，不会出现半截标记。
- 崩溃只可能丢「内存状态」：已落盘的行在下次同步扫描时被吸收，不会重复。
- 多实例同时写同一数据目录不受支持。
- 统计路由依赖 `webServer` 服务（web profile 提供）；无 webserver 的 profile 中插件照常记录数据，只是没有统计页。
- 统计页每次打开读取 rollup 聚合 + 当天 JSONL 重新计算；rollup 推进时才会触碰历史天文件（通常只有昨天的）。
