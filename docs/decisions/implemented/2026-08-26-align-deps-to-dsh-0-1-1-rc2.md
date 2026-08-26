# DR: 依赖对齐宿主 dsh 0.1.1-rc.2，移除死依赖 dsh-client-web-react

Status: implemented

## Problem

插件依赖的 `@deepseek-ai/*` SDK 家族停在 `^0.1.0-rc.7`，而实际宿主是 dsh `0.1.1-rc.2`（registry 上全部 SDK 包都有同版本号的 0.1.1-rc.2 线）。此外 devDependency 里的 `dsh-client-web-react` 在源码中零引用（仅 tsdown externals 列表残留），且它固定依赖 `dsh-client-ui-slots@^0.1.0-rc.7`，成为全家升级到 0.1.1 线的唯一解析死锁。

## Decision

15 个 `@deepseek-ai/*` 依赖中 14 个升到 `^0.1.1-rc.2`（与宿主同版本），`dsh-client-web-react` 整个移除（package.json + tsdown `PLATFORM_MODULES` externals 各删一行，源码本就无人 import）；传递依赖 `dsh-client-schema-form`（无 0.1.1 线）随新依赖闭包自然消失。旧 lock 残留会令 npm 解析器误报 ERESOLVE（引用已被升级的 0.1.0 peer 边），以同一份 package.json 在干净沙箱重新解析出 lock 再物化 node_modules 即可绕开。对齐后 typecheck、477 项测试、双构建全部通过，无任何 API 适配需求。

## Alternatives considered

- **留在 0.1.0-rc.7 / 升 rc.8** —— 与宿主代次不符；rc.8 仍是 0.1.0 线（caret 语义下 `^0.1.0-rc.7` 不会解析到 0.1.1-rc.x），且与宿主 0.1.1-rc.2 的运行时模块表不同代。
- **`--legacy-peer-deps` 强装** —— 掩盖真实冲突而非解决；还会要求项目永久携带该开关，下次任何人裸跑 `npm install` 即复现故障。
- **仅移除 web-react 不升版本** —— 只解死锁不对齐代次，宿主与插件的类型/运行时契约仍跨线。

## Consequences

- 代价：lock 全量重写（整个家族 rc.7 → 0.1.1-rc.2，一次性大 diff）；`dsh-client-web-react` 若未来需要引入，须先确认其发布线追上 0.1.1。
- 换来：插件与宿主 dsh 0.1.1-rc.2 同代，类型契约与运行时共享模块表一致；死依赖与残留 external 清理干净，依赖闭包里不再有 0.1.0 线包。
