# DR: 扩大会话表截断上限并恢复会话跳转与修饰键同步

Status: implemented

## Problem

7: 在设置页 Token 用量统计面板的“按会话”（bySession）明细表中，存在以下缺陷：
8: 1. **截断偏差导致最近会话不可见**：在 [2026-09-05-session-dimension-rollup.md](./2026-09-05-session-dimension-rollup.md) 中，服务端会话折叠后固定按费用降序并硬截断 Top 20（`SESSION_ROW_LIMIT = 20`）。虽然前端表头提供了按“最近活跃”（lastTime）和“总 Token”二次排序，但排序范围被局限在服务端下发的这 20 个历史上消费最高的会话内。当用户选择“全部日期”或长日期区间时，近期产生但单会话花费未挤进历史前 20 的活动会话完全被服务端丢弃，导致用户点击“最近活跃倒序”时，看到的最新活跃会话停留在一个多星期前（如 9 月 12 日），产生严重的数据失真。
9: 2. **会话跳转不可用与修饰键失步**：升级到 dsh 0.1.7 后原 `ISessions.open` 被废弃导致跳转被置为不可用；恢复跳转接线时若在插件 `apply` 阶段静态捕获 `ctx.sessions`，易受 Cordis 依赖加载时序影响而为 undefined；且键盘监听仅监听全局 `keydown`/`keyup`，窗口失焦或先按键后移入表格时会导致修饰键状态失步。
10: 3. **虚线呈现被裁切与已删除工作区跳转空白**：
11:    - 原 `.jumpable` 样式声明 `text-decoration: underline dashed` 与 `text-underline-offset: 3px`，在 `.sessionName` 具备 `overflow: hidden; text-overflow: ellipsis;` 的单行紧凑盒模型下，下划线超出盒边界被直接物理裁切，且颜色变量对比度过低，导致用户界面“按住 Ctrl 标题没有虚线但实际可以点击过去”；
12:    - 用户在 DSH 中删除了某个工作区后，该工作区从 `workspaces.items` 中移除，但历史会话仍然留存在用量统计中。用户点击该会话强行调用 `uiWorkspace.openSession` 时，DSH 宿主主视图因找不到工作区实体导致主屏直接呈现为一片空白。
13: 
14: ## Decision
15: 
16: 1. **扩大会话行截断上限消除截断偏差**：将 `src/stats.ts` 中的 `SESSION_ROW_LIMIT` 从 20 调整为 1000。对于普通开发工具使用场景，用户长期累计的会话数通常在数十至数百个（实测累计一个月 111 个顶层会话），折叠计算耗时仅约 8ms，网络传输体积极小（约 37KB）。将上限扩大至 1000 保证在不引入复杂分页机制的前提下，全量或大容量覆盖全部活跃会话，使得前端按“最近活跃”、“总 Token”或“费用”排序时均基于真实的完整会话集进行重排，彻底解决最近会话在“全部日期”下丢失的问题。
17: 2. **动态解析会话与工作区服务恢复跳转**：在 `src/client/index.ts` 中改用动态 getter 解析 `ctx.get('sessions')`（以及兼容属性访问）与 `ctx.get('uiWorkspace')`。在 `sessionListed` 判定时读取当前控制器的 `byId` 快照，在 `openSession` 中调用 `uiWorkspace.openSession(id)` 触发主视图导航并关闭设置面板。
18: 3. **工作区存活检测与跳空拦截**：注入并解析 `ctx.workspaces` 服务，通过 `workspaces.list.getSnapshot()` 检查所属工作区是否仍存活（`isWorkspaceAlive`）。对于已删除工作区的会话：
19:    - 按住 Ctrl 悬停时不展示虚线与手型指针（`sessionListed` 返回 false），明确表达不可跳转；
20:    - 若用户尝试点击该会话，拦截跳转（不调用宿主导航，不关闭设置页），并唤起 `<Toast>` 浮层警告提示用户“该会话所属工作区已删除，无法跳转”。
21: 4. **重构虚线样式为盒内边框规避裁切**：将 `.jumpable` 的下划线改为 `border-bottom: 1.5px dashed var(--dsw-alias-label-secondary)`，并在基础 `.sessionName` 预设透明底边框防止高度抖动；边框在自身盒模型内绘制，彻底规避 `overflow: hidden` 的裁剪问题，且提升颜色对比度以确保清晰醒目。
22: 5. **完善修饰键与鼠标移动事件自愈同步**：在 `src/client/SessionTable.tsx` 中除支持 `Control` 与 `Meta`（Mac Command 键）按键事件外，增加 `mousemove` 监听检查 `event.ctrlKey || event.metaKey`，在用户移动鼠标悬停时自动自愈校准 `ctrlHeld` 状态，防止切屏失焦导致的状态卡滞。
23: 
24: ## Alternatives considered
25: 
26: - **服务端支持按列动态排序参数**：在 `/token-usage/stats` 路由中增加 `sortBy` 与 `sortOrder` 参数并在服务端排序截断。输了：现行架构下切换表格排序是纯前端呈现状态，不产生网络 round-trip；在本地插件数据量（百级会话）下，将上限放宽至 1000 即可完全满足全集排序需求，无需改造 wire 契约与增加服务端请求复杂度。
27: - **取消一切 limit 限制**：完全不设上限。输了：极端异常情况下（如自动化脚本刷出几万个一次性子会话），无上限折叠可能导致单次响应体积与客户端 DOM 节点过大，保留 1000 作为安全护栏可兼顾完备性与防刷保护。
28: - **沿用静态闭包捕获服务**：在 `apply` 执行时一次性读取 `ctx.sessions`。输了：Cordis 插件与服务装配可能存在延迟就绪，静态读取为 undefined 会导致功能永久静默失效；动态 getter 零开销且时序鲁棒。
29: - **继续使用 text-decoration 下划线并微调 offset**：尝试将 `text-underline-offset` 调小。输了：不同浏览器与字体的基线、行高渲染不一，在单行紧凑溢出隐藏的按钮中极易发生边际裁切；盒模型内的 `border-bottom` 具有像素级确定性。
30: 
31: ## Consequences
32: 
33: - **所得**：在“全部日期”或长日期范围下，用户按最近活跃倒序排时，近期的全部活跃会话（包括当天及前几天的新会话）均完整准确展示；按住 Ctrl/Meta 键时有跳跃资格的会话标题即刻呈现清晰可见的虚线下划线，点击可直接跳转至对应会话并关闭设置页；已删除工作区的会话被明确置为不可跳，点击时弹出 Toast 提示拦截空白页；修饰键状态自愈鲁棒。
34: - **代价**：当总会话数在 20 到 1000 之间时，返回的 JSON 体积略有增加（约增加数十 KB），但仍在本地回环网络的毫秒级传输范畴内。
