# DR: 项目维度把 worktree 会话归属到仓库——`.dsh/gitworktree` 布局的 cwd 折叠

Status: implemented

## Problem

项目维度的分组键是会话 cwd 的目录尾段（`dirTailOf`）。dsh-worktree 插件的项目内布局把 worktree 建在 `<repo>/.dsh/gitworktree/<branch>`，于是同一仓库的 worktree 会话以分支目录名为尾段、被单独聚合成一个"项目"：`feature-dsh-market-publish`（7.9M）、`test-交互测试`（280K）都这样从各自仓库分裂了出去，项目计数、费用与命中率的口径随之碎片化；行 tooltip 展示的代表路径也指向 worktree 目录而非仓库。

## Decision

- **归属是纯字符串规则**：`src/project-rows.ts` 新增 `belongedCwdOf(cwd)`，路径中匹配 `[/\]\.dsh[/\]gitworktree[/\]<非空段>`（含 worktree 内更深子路径、兼容正反斜杠）即截断到 `.dsh` 之前——即仓库根；其余路径原样返回。字面量与 dsh-worktree 的布局常量 `join('.dsh', 'gitworktree')` 一致，大小写敏感（与其 `insideProjectLayout` 的 basename 精确比较同律）。
- **三个消费点统一走它**：`projectRowsOf` 在取尾段前先归属（host 侧完整项目维度 `projectRows`，[DR: 用量统计大屏化](./2026-10-24-usage-dashboard-isomorphic-board.md) 的共享折叠，浏览器老宿主 fallback 复用同一函数自动覆盖）；桶内代表 cwd 与 `UsageRows` 会话行副行的目录标签同样用归属后路径——tooltip 与副行指向仓库而非分支目录。
- **存储层不动**：`sessions.json` 与用量记录继续保存 header 的原始 cwd；归属只发生在聚合/展示层，规则升级后无需迁移即可重算。

## Alternatives considered

- **通用 git 检测（读 `<cwd>/.git` 文件的 `gitdir:` 指针识别任意 worktree）**——host 折叠在请求路径上，需要 IO 加缓存；浏览器老宿主 fallback 没有 fs，无法与 host 共享同一语义，两端规则必然漂移。本需求针对的 worktree 全部来自 dsh-worktree 的固定项目内布局，路径约定已足够。
- **在存储层把 `sessions.json` 的 cwd 改写为归属路径**——破坏"元数据索引是日志可重建的派生缓存、保存 header 原始事实"的层次；聚合语义放进聚合层，才能随规则演进原地重算。
- **大小写不敏感匹配布局段（Windows fs 语义）**——与 dsh-worktree 权威判定不一致，两个插件对"同一目录是否 worktree"会给出不同答案；布局目录由插件创建，字面恒为小写。

## Consequences

- 代价：dsh-worktree 的 legacy 集中根 `~/.dsh/gitworktree/<name>` 若再出现会话，会被归到用户主目录（项目名=用户名）——该位置已是只读历史、不再新建，接受这一边界；一个恰好含有 `.dsh/gitworktree/<x>` 子目录的普通项目也会被折叠（无 fs 探测无法证伪 `.git`，概率极低）。
- 换来：host 折叠、浏览器 fallback、会话行标签三处同一归属语义，零 IO、零迁移；worktree 会话并入所属仓库的项目行，项目计数与费用不再分裂，tooltip 指向仓库根。
