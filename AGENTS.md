非平凡变更须在同一个提交里新增或更新 docs/decisions/ 下的决策记录，规范见 docs/decisions/README.md

除非用户主动申明，禁止打版本（禁止 bump package.json 的 version 或执行发布流程；版本与发布由用户决定）

发版升号时须同步在根目录 CHANGELOG.md 中补充对应版本的更新说明（供 publish.yml 自动同步为 GitHub Release）。
