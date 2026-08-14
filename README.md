# token-usage

dsh 本地插件：按请求粒度持久化模型 token 用量。

- **实时 hook**：每次模型请求成功后（`assistant/message` 会话事件）追加一行到按天分片的 JSONL 文件。
- **首次启动自动同步一次**：补齐插件安装前已发生的历史请求（`state.json` 标记判定，之后永不自动重复；崩溃重试由请求 id 去重保证幂等）。
- **手动再同步命令**：`/token-usage-sync`（Web 命令面板）随时手动补写，以请求 id 去重，与实时数据不重复。

## 安装与移除

### 安装（永久，推荐）

从 Git 仓库安装（推荐）：

```sh
dsh plugin --profile web add github:<用户名>/dsh-token-usage
# 或指定仓库 URL：
# dsh plugin --profile web add git+https://github.com/<用户名>/dsh-token-usage.git
```

从本地目录安装：

```sh
dsh plugin --profile web add link:E:/Documents/MyCode/oyw-dsh-plugin/dsh-token-usage
```

包声明了 `dsh.bundle`，`add` 会自动把插件加入该 profile 的层栈，**无需手动编辑任何配置文件**。首次启动会自动执行一次历史补齐（终端打印 `[token-usage] first-run sync: N added, M skipped`），之后纯实时记录。

> 更新到最新版本：`dsh plugin --profile web update dsh-token-usage`。仓库已提交 `lib/` 构建产物（`.gitignore` 不忽略），改代码后需 `pnpm run build` 并提交新产物。

### 移除

```sh
dsh plugin --profile web remove dsh-token-usage
```

自动从层栈移除并停止加载。数据文件（`$DSH_HOME/token-usage/`）会保留，需要时手动删除。

### 临时挂载（覆盖层，不动 profile）

```sh
dsh web --patch E:/Documents/MyCode/oyw-dsh-plugin/dsh-token-usage/cordis.yml
```

仅当次启动生效。`cordis.yml` 指向 built 产物 `lib/index.js`；修改源码后运行 `pnpm run build`（或 `tsc --watch`）再重启 dsh。

> Windows 上运行 built 安装版 dsh 时，临时覆盖层的插件条目必须用 `file:///` URL 形式（仓库内 `cordis.yml` 已写好）；源码运行（tsx）两种形式都接受。bundle 安装方式无此问题（按包名解析）。

## 配置

`cordis.yml` 的插件条目可带 `config:`：

```yaml
- insert:
    - id: token-usage
      name: 'E:/Documents/MyCode/oyw-dsh-plugin/token-usage/lib/index.js'
      config:
        path: 'C:/data/token-usage'   # 数据目录；缺省 $DSH_HOME/token-usage（$DSH_HOME 未设时为 ~/.dsh/token-usage）
```

未知配置键在加载时直接报错。

## 数据格式

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

## 同步命令

命令面板执行 `/token-usage-sync`：扫描数据文件重建去重集合 → 枚举磁盘上全部持久化会话 → 补写缺失请求行，返回「新增 N 条 / 去重跳过 M 条」。重复执行是幂等的。

首次启动（数据目录无 `state.json`）会自动执行一次同样的同步，完成后写入标记；之后启动不再自动同步。

## 语义与限制

- 只记录**成功**请求（有 `assistant/message` 事件）；失败/取消请求和 step 内重试的中间尝试不记录。
- 首次同步标记缺失或损坏时视为未初始化：下一次启动会重跑同步（去重后为无操作），标记以临时文件 + 原子改名写入，不会出现半截标记。
- 崩溃只可能丢「内存状态」：已落盘的行在下次同步扫描时被吸收，不会重复。
- 多实例同时写同一数据目录不受支持。
