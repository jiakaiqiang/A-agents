# 上下文管理开发进度（task.md 锚点）

> 四份文档：docs/specs/context-management/{spec,plan,task,checklist}.md，均已批准（2026-09-20）。
> 每项一行，做完打勾。验证命令在 typescript/ 下执行。

- [x] T1 常量集中：compactor.ts 顶部导出全部阈值（AUTO_MARGIN 13K / MANUAL_MARGIN 3K / KEEP_RECENT 10K+5条 / 熔断 3 次）
- [x] T2 src/context/tokens.ts：Token 估算器（锚定 usage + 增量字符估算）
- [x] T3 src/context/spill.ts：工具结果存盘（项目内目录、命名、预览替换）
- [x] T4 src/context/summarizer.ts：摘要 Prompt（禁工具、草稿、九段结构）
- [x] T5 src/context/compactor.ts：两层压缩编排（分界计算、熔断计数、边界消息）
- [x] T5b src/agent/events.ts：新增 compaction 事件
- [x] T5c conversation.ts：chars() 辅助（锚点与估算共用口径）
- [x] T6 loop.ts 接入：maintain / applyLightPrevention / noteUsage / compaction 事件
- [x] T7 app.tsx：/compact 命令 + 压缩提示 + 熔断提示 + compactorRef
- [x] T7b .gitignore：**/.mewcode/tool-outputs/（git check-ignore 已验证命中）
- [x] T8 tests/context/tokens.test.ts（8 用例）
- [x] T9 tests/context/spill.test.ts（6 用例）
- [x] T10 tests/context/summarizer.test.ts（8 用例）
- [x] T11 tests/context/compactor.test.ts（17 用例）
- [x] T12 tests/agent/loop.test.ts 压缩集成用例（4 用例）
- [x] T13 全量回归 + typecheck：329 pass / 0 fail，tsc 零错误
- [ ] T14 端到端手工验证（长对话触发压缩，需真实 provider；对照 checklist.md 阶段六）
