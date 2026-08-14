# dsh-token-usage

dsh 本地插件：按请求粒度持久化模型 token 用量，写入按天分片的 JSONL 文件。

仓库：<https://github.com/LaoYueHanNi/dsh-token-usage>

## 功能

- **实时 hook**：每次模型请求成功后（`assistant/message` 会话事件）追加一行，包含请求 id、模型名、四项 token 用量、时间、会话 id。
- **首次启动自动同步一次**：补齐插件安装前已发生的历史请求（`state.json` 标记判定，之后永不自动重复；崩溃重试由请求 id 去重保证幂等）。
- **手动再同步命令**：`/token-usage-sync`（Web 命令面板）随时手动补写，以请求 id 去重，与实时数据不重复。

## 安装与移除

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
# 或指定仓库 URL：
# dsh plugin --profile web add git+https://github.com/LaoYueHanNi/dsh-token-usage.git
# dsh plugin --profile web add git+ssh://git@github.com/LaoYueHanNi/dsh-token-usage.git
```

### 从本地目录安装（开发调试用）

```sh
dsh plugin --profile web add link:E:/Documents/MyCode/oyw-dsh-plugin/dsh-token-usage
```

包声明了 `dsh.bundle`，`add` 会自动把插件加入该 profile 的层栈，**无需手动编辑任何配置文件**。首次启动会自动执行一次历史补齐（终端打印 `[token-usage] first-run sync: N added, M skipped`），之后纯实时记录。

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
dsh web --patch E:/Documents/MyCode/oyw-dsh-plugin/dsh-token-usage/cordis.yml
```

仅当次启动生效。`cordis.yml` 指向 built 产物 `lib/index.js`。

> Windows 上运行 built 安装版 dsh 时，临时覆盖层的插件条目必须用 `file:///` URL 形式（仓库内 `cordis.yml` 已写好）；源码运行（tsx）两种形式都接受。bundle 安装方式无此问题（按包名解析）。

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

## 同步机制

- **首次启动**（数据目录无 `state.json`）自动执行一次全量同步：扫描数据文件重建去重集合 → 枚举磁盘上全部持久化会话 → 补写缺失请求行；完成后写入标记，之后启动不再自动同步。
- **手动命令**：命令面板执行 `/token-usage-sync`，返回「新增 N 条 / 去重跳过 M 条」。重复执行是幂等的。

## 开发

```sh
pnpm install
pnpm run typecheck   # 类型检查
pnpm run test        # vitest 单元 + 集成测试
pnpm run build       # tsc 产出 lib/
```

仓库**已提交 `lib/` 构建产物**（`.gitignore` 不忽略），改代码后需重新构建并提交：

```sh
pnpm run build
git add -A
git commit -m "your change"
git push
```

### 项目结构

```
src/
  index.ts          # 插件入口：实时 hook + 首次自动同步 + 命令注册 + Config
  usage-record.ts   # 行类型、事件→记录投影、序列化/解析（纯函数）
  usage-log.ts      # 按天 JSONL 写入队列、请求 id 去重集合、扫描重建
  sync.ts           # 同步算法 + 首次自动同步编排
  sync-state.ts     # state.json 初始化标记（原子写入）
cordis.patch.yml    # bundle 层补丁（dsh plugin add 自动启用）
cordis.yml          # 临时 --patch 覆盖层（file:// URL 形式）
```

## 语义与限制

- 只记录**成功**请求（有 `assistant/message` 事件）；失败/取消请求和 step 内重试的中间尝试不记录。
- 首次同步标记缺失或损坏时视为未初始化：下一次启动会重跑同步（去重后为无操作），标记以临时文件 + 原子改名写入，不会出现半截标记。
- 崩溃只可能丢「内存状态」：已落盘的行在下次同步扫描时被吸收，不会重复。
- 多实例同时写同一数据目录不受支持。
