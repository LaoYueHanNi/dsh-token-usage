# DR: 以 @laoyuehanni/dsh-token-usage 发布到公共 NPM

Status: implemented

## Problem

分发渠道只有 `github:` 直装（`dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage`），安装绑定 git 协议与仓库可达性，享受不到 registry 的版本解析与 lock 语义。同时 package.json 按"私有仓库"形态维护：`private: true` 阻止任何 `npm publish`；缺 `license` 字段与 LICENSE 文件；无 `files` 白名单（打包范围不可控）；`exports["."]` 用字符串简写未声明类型入口。发包前这些缺口必须补齐。

## Decision

以 scoped 包名 **@laoyuehanni/dsh-token-usage** 发布到公共 registry，版本沿用 0.3.7 作首版。package.json 补齐元数据：移除 `private`，声明 `license: MIT`（LICENSE 于 GitHub 网页先行添加）、author/repository/bugs/homepage/keywords；`exports["."]` 展开为对象并补 `"types"`，顶层加 `"types"`；新增 `files` 白名单 `["lib", "cordis.patch.yml", "README.md", "README.zh.md"]`（package.json 与 LICENSE 自动随包）。新增 `prepublishOnly` 串联 typecheck → test → build → build:client，保证每次 publish 产物新鲜且全绿。`publishConfig.registry` 固定发布目标为官方 registry.npmjs.org——发布者本机常配国内镜像（npmmirror）加速安装，镜像账号体系独立且单向同步，凭 package.json 字段兜底可防止任何机器上误发到镜像。发版方式为手动流程：commit → `npm publish --access public`（scoped 首发必须显式公开）。README 在线上验证通过后收尾为只保留 npm 安装命令。`cordis.patch.yml` 的 `name` 字段是宿主加载插件时的 import 模块说明符，包改名后必须同步为 scoped 名（`@laoyuehanni/dsh-token-usage`）——0.3.7 漏改导致 npm 安装后启动报 `ERR_MODULE_NOT_FOUND`，0.3.8 修正。同类死角还有客户端 bundle：tsdown 构建时把插件 id 烧进 `__ModuleLoader__.load` 注册横幅，宿主校验"注册 id 必须等于 loader 入口的包名"，0.3.9 起 PLUGIN_ID 改为构建时从 package.json 派生，改名不再可能失配。

## Alternatives considered

- **沿用原名 dsh-token-usage** —— registry 上已被第三方占用（同名包 latest 2.2.0，维护者为他人），publish 会被拒，此路不通。
- **unscoped 改名 dsh-token-usage-plugin** —— 已核验可用，但 dsh-* 命名空间已挤满功能雷同的第三方插件（dsh-usage-stats、dsh-plugin-token-usage 等），裸名易混淆劫持检索；scope 名唯一映射到发布者账号。
- **继续仅 github: 直装不分发** —— 无版本区间解析、安装受 fork/改名影响，且与宿主生态向 registry 迁移的方向相悖。

## Consequences

- 代价：包名变化要求 README 与既有用户改用新安装名。经 pnpm 10 实测，旧 `github:` 安装（依赖键 `dsh-token-usage`）用 `update` 无法迁移：pnpm 只在原 git 渠道重新解析，且按仓库现名装出 scoped 包后宿主按 patch 的 import 说明符（`@laoyuehanni/dsh-token-usage`）在 `node_modules` 下解析不到对应目录，启动报 `ERR_MODULE_NOT_FOUND`；按新名 `update` 则因依赖键不存在而静默无效。故 README 顶部放置迁移指引（先 `remove dsh-token-usage` 再 `add` npm 包，数据目录不受影响）；每次发布必须在发布机跑完整 typecheck+test+双构建（耗时换安全）；publish 者必须持有 npm 上 laoyuehanni scope 的权限；双 lockfile 继续留在仓库但被 files 白名单排除在 tarball 外。
- 换来：获得 registry 的语义化版本分发与 `install` 一行安装；公共包规范（许可证/元数据/入口类型声明）全部齐备；prepublishOnly 兜底使"忘构建就发包"这类事故结构性消失。
