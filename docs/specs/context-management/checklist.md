# 上下文管理 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。
> 验证命令在 typescript/ 下执行。
> 2026-09-24 验收：`bun run typecheck`、`bun test`（332 pass / 0 fail）、`bun run scripts/verify-context-real.ts`、`bun run scripts/verify-context-real.ts --circuit-only` 均通过。真实 Ink TUI 已观察自动压缩提示和连续两次 `/compact` 提示。熔断场景注入摘要请求失败，主对话仍调用真实 provider，并非真实断网。未勾选项仍需补充对应验证。

## 实现完整性

- [x] TokenEstimator 可用且口径正确（验证：`bun test tests/context/tokens.test.ts` 全绿——无锚点 1000 字符 = 250 tokens，锚点后只算增量）
- [x] 工具结果存盘可触发且文件可读回（验证：`bun test tests/context/spill.test.ts` 全绿——文件名含工具名+时间戳，内容=完整原文）
- [x] 摘要生成器产出结构化摘要且无工具调用（验证：`bun test tests/context/summarizer.test.ts` 全绿——假客户端收到的 tools 为空数组）
- [x] Compactor 编排两层策略并管理熔断（验证：`bun test tests/context/compactor.test.ts` 全绿）

## 轻量预防行为

- [x] 单条工具结果估算 >2K tokens 时，历史里是「预览+路径」而非原文（验证：loop 集成测试用例——脚本产出大结果，断言历史中 content 含存盘路径）
- [x] 单条消息合计 >8K tokens 时从最大结果依次存盘至达标（验证：compactor 测试——多条合计超限，断言替换后合计 ≤8K 且最大者先被替换）
- [x] 存盘预览含开头 ~500 字符与 Read 提示（验证：spill 测试断言预览格式）
- [x] 未超阈值的工具结果原文不变（验证：spill 测试用例 1）

## 重量兜底行为

- [x] 总估算超过「窗口−13K」时自动触发压缩，未超不触发（验证：compactor 测试——注入小窗口，断言 maintain 前后历史变化）
- [x] 分界满足「尾部 10K tokens 或 5 条自然语言消息先到为准」，工具结果消息不占名额（验证：compactor 测试 splitHistory 用例）
- [x] 摘要 Prompt 含九段结构、禁工具、草稿要求（验证：summarizer 测试断言 Prompt 文本）
- [x] 待摘要区超大时请求前截短到安全大小（验证：summarizer 测试——注入超大历史，断言实际发出条数 ≤ 截短后）
- [x] 压缩后历史 = 摘要 user 消息 + 近期原文 + 边界消息，近期原文内容逐字不变（验证：compactor 测试断言三段结构与内容）
- [x] 压缩完成后估算锚点重置（验证：compactor 测试——压缩后 estimate 不再受旧锚点影响）

## 触发与熔断

- [x] /compact 无阈值直接压缩，TUI 显示压缩提示（验证：端到端手工——输入 /compact，观察到含条数的系统提示）
- [ ] 压后剩余 <3K tokens 时出现异常提示（验证：compactor 测试 + 端到端）
- [x] 摘要连续失败 3 次后自动压缩停止、用户收到熔断提示（验证：compactor 测试——假 client 抛错 3 次，maintain 不再调 client）
- [x] 手动 /compact 成功后熔断解除（验证：compactor 测试——熔断后 resetFailures，maintain 恢复工作）
- [x] 每次请求前跑两层检查（含同轮工具回灌后）（验证：loop 集成测试——单轮多次迭代中 maintain 被调用多次）

## 集成

- [x] loop 接入 Compactor 后既有行为不变（验证：`bun test tests/agent/loop.test.ts` 原 17 用例全绿）
- [x] compactor 缺省时 runLoop 不做任何压缩（验证：T13 用例 2）
- [x] 工具行展示流程不受存盘影响（验证：loop 测试 tool_start/tool_end 事件正常出现）
- [x] 中断信号下压缩不替换历史（验证：compactor 测试用例 6）

## 编译与测试

- [x] `bun run typecheck` 零错误
- [x] `bun test` 全量通过（基线 286 + 新增用例）
- [x] `.gitignore` 含 `.mewcode/tool-outputs/`（验证：`git check-ignore` 命中）

## 端到端场景

- [x] 场景 1：让模型读取一个 >10K 行的大文件 → 工具结果被存盘，对话行显示预览；随后问文件细节 → 模型用 Read 读存盘文件或原文件得到正确答案
- [x] 场景 2：连续多轮大输出对话逼近窗口 → 自动压缩发生，TUI 出现压缩提示，对话继续不中断，模型能引用摘要推进任务
- [x] 场景 3：/compact 手动触发 → 立即压缩并提示；连续多轮对话后再次 /compact 仍可用
- [x] 场景 4：无网络/摘要请求失败连续 3 次 → 熔断提示出现，会话仍可正常对话（不再自动压缩）
