# DR: 首次启动无显式 path 时等待 settings 附着，不再短窗兜底打开默认目录

Status: implemented

## Problem

插件首次启动以 500ms 短窗（`startupDeferMs`）等待 settings 服务（`installSettingsSection` 的 `ctx.inject(['settings'])`）附着，超时即兜底在组合默认目录（`$DSH_HOME/token-usage`）上启动。宿主 base bundle 在 0.1.2-alpha.1 中于 settings-file 行之前插入了一整组新服务（storage 存储 hub/json/domain、session-projection-cache、deepseek-llm-api-extensions 等，`cordis.patch.yml` 中该行从 79 移到 91），这些行的启动期异步工作把 settings 附着稳定推过 500ms。于是每次启动：兜底先在默认目录启动并写入 pricing/state 文件，settings 附着后再 relocate default → stored，日志打印一串 moving/cleaning，默认目录被无意义地写入又清空。实测仅与宿主版本相关（0.1.1-rc.2 不复现），与插件构建渠道无关（服务端代码相同）。本修复独立于宿主迁移工作（`feat/dsh-0.1.2-alpha.1` 分支的适配，含其自身的决策记录）先行落地。

## Decision

首次启动拆成两条路径（`src/index.ts` 的延迟启动块）：

- 组合配置显式指定 `path`：500ms 短窗兜底照旧——显式放置就是意图；settings 附着后若 stored 不同，按真实编辑 relocate。
- 无显式 `path`：短窗兜底彻底移除。首次启动只能由 settings attach 的 `onChange` 触发（在解析出的目录上）；仅当宿主根本没有 settings 服务时，由 30s 长兜底（新配置键 `startupCapMs`）在默认目录启动。两条路径的启动调用幂等，重叠互不干扰。

`startupCapMs` 与 `startupDeferMs` 同性质，是测试旋钮而非用户面配置；默认 30s 的唯一约束是必须长于任何真实宿主启动的 settings 附着耗时。

## Alternatives considered

- **调大 `startupDeferMs` 默认值（如 5s）** —— 仍是赌固定窗口：宿主启动耗时不受本插件控制，0.1.2 已证明 500ms 会被突破，未来版本可能突破任何值；且窗口期间所有正常宿主的首次启动都被无谓拖住。
- **兜底启动时跳过 pricing sync、不写任何文件** —— 治标不治本：默认目录仍被打开（UsageLog、record cache），relocate 仍会发生并打印 moved 日志（0 文件搬迁），日志噪音不减。
- **在默认目录留"已迁移到 X"标记文件，启动直读标记** —— 引入第三份持久状态（标记文件、settings.yaml、cordis.yml）的一致性问题：用户改 settings 后标记指向失效路径的清理、跨机器复制 home 等边角都需要处理；而 settings attach 本身就是权威信号，等它即可，无需新状态。

## Consequences

- 换来：任何宿主上启动日志安静，默认目录零写入零搬迁；首次启动的目录不再依赖对宿主启动耗时的猜测。
- 代价：无显式 `path` 且 settings 附着迟缓的宿主上，usage 记录与 stats/quota 路由要等 settings 附着才可用（启动后用户尚未开始会话，实际不可感）；无 settings 服务的宿主首次可用延迟一个 cap 周期（宿主启动本身不被阻塞）。修复随 0.1.2 适配分支发布，已发布的 0.3.10 不回移。
