# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![Token 用量统计页](token-usage.png)

简体中文 | [English](./README.md)

一个 [dsh] 用量插件：在 Web 界面直接展示模型 token 用量。安装后打开**设置**（侧栏底部齿轮），即可看到「Token 用量」页 —— 汇总卡片、按日总 token 折线图、按模型明细表，支持按日期区间和模型筛选，效果见上图。

[dsh]: https://github.com/cordiverse/dsh

仓库：<https://github.com/LaoYueHanNi/dsh-token-usage>

## 功能

- **实时记录**：每次成功的模型请求追加一行到按天分片的 JSONL 文件（请求 id、模型、输入 / 输出 / 缓存读 / 缓存写 token、时间、会话 id）。
- **Web 统计页**：过滤条（日期区间 + 模型下拉 + `1d`/`7d`/`30d` 快捷区间）、汇总卡片、按日趋势图、按模型明细表。
- **费用统计与模型定价**：按模型单价（¥/百万 token）实时计算费用 —— 汇总卡醒目展示总费用，按模型表每行带费用列与单价小字，未定价模型高亮提示（费用按 ¥0 计）。定价表由你维护在数据目录的 `pricing.json`，`/token-usage-pricing` 命令可随时查看当前生效的定价。
- **历史补齐**：首次启动自动同步安装前已发生的请求；`/token-usage-sync` 命令可随时手动补写（幂等）。

## 模型定价

费用 = 各 token 桶 × 对应单价 ÷ 100 万。单价在数据目录的 `pricing.json` 中维护（默认无定价，全部按未定价处理），格式如下：

```json
{
  "deepseek-chat": { "inputPerMillion": 2, "outputPerMillion": 8, "cacheReadPerMillion": 0.5 },
  "deepseek-reasoner": { "inputPerMillion": 4, "outputPerMillion": 16, "cacheReadPerMillion": 1 }
}
```

- 键为模型 id（与记录中的 `model` 完全一致），值为每百万 token 单价（¥）。
- `inputPerMillion`、`outputPerMillion` 必填；`cacheReadPerMillion`（缓存命中）、`cacheWritePerMillion`（缓存写入）可选，缺省时按输入单价计费。
- 文件损坏或条目非法时对应模型按未定价处理，不影响统计页；保存后刷新页面或重跑命令即可生效。
- 默认数据目录：`~/.dsh/token-usage/pricing.json`（配置了 `path` 时以该目录为准）。

## 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
```

> 包声明了 `dsh.bundle`，`add` 会自动把插件挂进 profile 的层栈，无需手动改配置。构建产物 `lib/` 随仓库提交（没有 `prepare` 脚本），git 安装开箱即用，无需任何构建白名单配置。首次启动自动补齐一次历史记录，之后纯实时记录。

### 从本地目录安装（开发调试用）

```sh
dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

`link:` 安装的是符号链接：重新构建插件后重启 `dsh web` 即可生效。

## 更新

```sh
dsh plugin --profile web update dsh-token-usage
```

## 移除

```sh
dsh plugin --profile web remove dsh-token-usage
```

插件会从 profile 移除并停止加载。数据文件（`$DSH_HOME/token-usage/`）会保留，需要时手动删除。

## 开发

先构建一次插件：

```sh
npm install
npm run build && npm run build:client
```

> **刻意不设 `prepare` 脚本。** 编译产物 `lib/` 已提交进仓库。pnpm ≥ 10 默认拒绝执行 git-hosted 依赖的构建脚本，除非加入白名单（报错 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），因此若保留 `prepare`，每个用户用 `github:` 安装都会失败。改为随仓库分发预构建产物后，`dsh plugin add github:LaoYueHanNi/dsh-token-usage` 才能零配置开箱即用。**改动 `src/` 下的任何文件后，务必重新构建并提交更新后的 `lib/`**，否则别人安装到的是旧产物：

```sh
npm run build && npm run build:client
git add lib/
```

临时挂载 —— 仅当次启动生效，不动 profile，`cordis.yml` 指向构建产物 `lib/index.js`：

```sh
dsh web --patch <插件目录>/cordis.yml
```

此模式只挂载 host 半边（数据记录与命令照常工作）；统计页依赖按包名解析的客户端 bundle，因此开发 UI 请用上面的 `link:` 安装方式：执行 `npm run build && npm run build:client`（或在插件目录跑 `npx tsdown --watch`）并重启 `dsh web` 后，浏览器端插件会自动热重载。
