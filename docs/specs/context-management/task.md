# 上下文管理 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/context/tokens.ts` | TokenEstimator、estimateChars |
| 新建 | `src/context/spill.ts` | maybeSpillResult、预览生成、存盘常量 |
| 新建 | `src/context/summarizer.ts` | buildSummaryPrompt、generateSummary、truncateForSummary |
| 新建 | `src/context/compactor.ts` | Compactor 类、阈值常量 |
| 修改 | `src/agent/events.ts` | AgentEvent 新增 compaction |
| 修改 | `src/agent/loop.ts` | 接入 compactor：maintain / applyLightPrevention / noteUsage / 事件 |
| 修改 | `src/conversation/conversation.ts` | chars() 辅助方法 |
| 修改 | `src/tui/app.tsx` | /compact 命令、compactorRef、compaction 呈现 |
| 修改 | `.gitignore`（仓库根） | 追加 .mewcode/tool-outputs/ |
| 新建 | `tests/context/tokens.test.ts` | 估算器用例 |
| 新建 | `tests/context/spill.test.ts` | 存盘用例 |
| 新建 | `tests/context/summarizer.test.ts` | 摘要用例 |
| 新建 | `tests/context/compactor.test.ts` | 编排与熔断用例 |
| 修改 | `tests/agent/loop.test.ts` | loop 集成压缩用例 |

## T1: 常量与 Token 估算器

**文件：** `src/context/tokens.ts`
**依赖：** 无
**步骤：**
1. 定义 `estimateChars(message: Message): number`：自然语言取 content.length；toolResults 各项 content.length 之和；toolUses 取 JSON.stringify 长度。
2. 实现 `TokenEstimator`：`setAnchor(historyChars, inputTokens)`、`resetAnchor()`、`estimate(totalChars)`（锚点存在时 = inputTokens + max(0, totalChars−anchorChars)/4，否则 totalChars/4，向下取整）。
3. 提供 `estimateMessages(messages: Message[])` 便捷入口。
4. 常量 `CHARS_PER_TOKEN = 4` 导出。

**验证：** `bun test tests/context/tokens.test.ts` 通过（T10 用例先行编写亦可，此处至少编译通过）；`bun run typecheck` 无错。

## T2: 工具结果存盘（第一层核心）

**文件：** `src/context/spill.ts`
**依赖：** T1
**步骤：**
1. 导出常量：`SPILL_PREVIEW_CHARS = 500`、`TOOL_SPILL_TOKENS = 2_000`、`MESSAGE_SPILL_TOKENS = 8_000`。
2. 实现 `spillToFile(toolName, content, workDir)`：目录 `<workDir>/.mewcode/tool-outputs/`（mkdirSync recursive），文件名 `<toolName>-<yyyyMMdd-HHmmss>-<6位随机>.txt`，写完整原文，返回 POSIX 风格绝对路径；任何写错误返回 null。
3. 实现 `buildPreview(content, filePath)`：原文前 500 字符 + `\n\n[完整输出已存盘：<路径>（N 字符）。需要细节请用 Read 读取该文件]`。
4. 实现 `maybeSpillResult(toolName, result, workDir, estimator)`：估算该结果 tokens，超过 `TOOL_SPILL_TOKENS` 则存盘并返回 `{ content: 预览, spilled: true, filePath }`；存盘失败或未超阈值返回原文。

**验证：** `bun test tests/context/spill.test.ts` 通过；临时目录中生成预期文件名的文件。

## T3: 摘要生成器（第二层核心）

**文件：** `src/context/summarizer.ts`
**依赖：** T1
**步骤：**
1. 实现 `buildSummaryPrompt(history)`：system 文本含三条硬规则（禁用工具、先写分析草稿再写正式摘要、草稿用完即弃不入正式输出）；user 文本含九段结构模板（主要请求和意图/关键技术概念/文件和代码段/错误和修复/问题解决过程/所有用户消息/待办任务/当前工作/可能的下一步）+ 待摘要消息的文本化转储。
2. 实现 `truncateForSummary(history)`：从尾部保留 5 轮原始对话（一个 assistant 带 toolUses + 其配对 tool_result 算一轮；独立 user/assistant 消息各自算条），更早部分替换为一行占位 `[更早的对话已省略]`，返回新数组不改原数组。
3. 实现 `generateSummary(client, history, signal)`：估算请求大小，必要时先用 `truncateForSummary` 截短；调 `client.stream(伪 Conversation, 空工具数组, { signal })` 收集 text_delta 拼接，忽略 toolUses；返回 `{ summary, usage }`。伪 Conversation 用轻量对象实现 `getMessages()` 即可（构造一个含完整待摘要历史的 manager 亦可——直接 new ConversationManager 并 addUserMessage 灌入转储文本更简单）。

**验证：** `bun test tests/context/summarizer.test.ts` 通过；假客户端收到的 tools 参数为空数组。

## T4: Compactor 编排

**文件：** `src/context/compactor.ts`
**依赖：** T1, T2, T3
**步骤：**
1. 导出常量：`AUTO_MARGIN_TOKENS = 13_000`、`MANUAL_MARGIN_TOKENS = 3_000`、`KEEP_RECENT_TOKENS = 10_000`、`KEEP_RECENT_NATURAL = 5`、`MAX_SUMMARY_FAILURES = 3`。
2. 实现 `splitHistory(messages)`：从尾向前累计 token，遇自然语言消息（user 且无 toolResults，或 assistant 且 content 非空）计数；`tokens ≥ KEEP_RECENT_TOKENS || natural ≥ KEEP_RECENT_NATURAL` 先到即停；返回 `{ toSummarize, recent }`；历史不足分界时 recent = 全部、toSummarize = 空。
3. 实现 `Compactor` 类：
   - 构造持有 `client, conversation, estimator, workDir`；内部 `failureCount = 0`。
   - `noteUsage(historyChars, inputTokens)` → `estimator.setAnchor`。
   - `applyLightPrevention(results)`：先按 F2 逐条判定（单条超 2K → maybeSpillResult），再按 F3 合计判定：估算全组 tokens，超 8K 从最大者开始依次替换为预览，重算直至 ≤ 8K。返回新结果数组。
   - `maintain(signal)`：熔断开 → 返回；估算全历史 `> 窗口−AUTO_MARGIN_TOKENS` → `runCompaction(false, signal)`。
   - `compactManually(signal)` → `runCompaction(true, signal)`。
   - `runCompaction(manual, signal)`：splitHistory；toSummarize 为空且 manual 时直接对全历史摘要（近期区为空的极端情况按「至少保留最近 1 条」处理）；`generateSummary`；组装 `[摘要 user 消息, ...recent, 边界消息]`；`replaceWithCompacted`；`resetAnchor`；成功时 failureCount=0，失败 +1 且达 3 返回熔断错误。
   - `resetFailures()`：failureCount=0、熔断解除。
   - `circuitOpen` getter；`remainingTokens()`：窗口 − 估算，供 /compact 压后校验。
   - 窗口值通过构造参数注入（TUI 从 provider 取 `getContextWindow`，测试注入小窗口），不直接 import config。
4. 边界消息文本：「以上是对较早对话的结构化摘要。摘要可能丢失文件内容细节：需要文件的具体内容时，请用 Read 重新读取原文件，不要根据摘要臆测代码。」

**验证：** `bun test tests/context/compactor.test.ts` 通过；`bun run typecheck` 无错。

## T5: AgentEvent 与 conversation 辅助

**文件：** `src/agent/events.ts`、`src/conversation/conversation.ts`
**依赖：** 无（与 T1 并行）
**步骤：**
1. events.ts：AgentEvent 联合新增 `{ type: "compaction"; text: string }`。
2. conversation.ts：新增 `chars(): number`——遍历 history 调 estimateChars 同口径求和（为避免循环依赖，此处内联同口径的字符统计逻辑，不 import context 模块）。

**验证：** `bun run typecheck` 无错；`bun test tests/agent/loop.test.ts` 既有用例不红。

## T6: loop 接入

**文件：** `src/agent/loop.ts`
**依赖：** T1–T5
**步骤：**
1. `LoopOptions` 新增 `compactor?: Compactor`。
2. 请求前（while 循环内、collectStream 之前）：`await options.compactor?.maintain(signal)`；若压缩发生（maintain 返回结果含提示文本）则 `yield { type: "compaction", text }`。
3. 工具结果回灌前：`const processed = options.compactor ? await options.compactor.applyLightPrevention(results) : results;` 用 processed 调 `addToolResultMessage`。
4. `addUsage` 之后：`options.compactor?.noteUsage(conversation.chars(), response.usage.inputTokens)`。
5. 保持既有行为不变：compactor 缺省时所有调用跳过。

**验证：** `bun test tests/agent/loop.test.ts` 通过（含 T14 新增用例）。

## T7: TUI 接入

**文件：** `src/tui/app.tsx`
**依赖：** T4, T6
**步骤：**
1. 新增 `compactorRef = useRef<Compactor | null>(null)`；client 创建成功的 effect 里，取 `getContextWindow(selectedProvider)` 构造 Compactor（estimator、conversationRef.current、workDir）。
2. `handleSubmit` 增加 `/compact` 分支：isStreaming 时忽略；无 client 时提示；否则调 `compactManually()`，按 `CompactionResult` 与 `remainingTokens()` 显示系统消息：成功 → 「已压缩历史：X 条消息 → 摘要 + 近期 Y 条原文」；`remainingTokens() < MANUAL_MARGIN_TOKENS` → 追加异常提示「压缩后剩余空间不足 3K tokens」；熔断中成功 → 提示自动压缩已恢复。
3. runLoop 事件处理新增 `compaction` case：与 notice 同路径渲染系统消息。
4. runLoop 调用处传入 `compactor: compactorRef.current`。

**验证：** `bun run typecheck` 无错；`bun test` 全量不红。

## T8: .gitignore

**文件：** `.gitignore`（仓库根）
**依赖：** 无（与 T1 并行）
**步骤：**
1. 追加一段：`# 工具结果存盘目录（上下文管理第一层预防）` 与 `.mewcode/tool-outputs/`。

**验证：** `git check-ignore -v typescript/.mewcode/tool-outputs/test.txt` 输出命中规则。

## T9: 估算器测试

**文件：** `tests/context/tokens.test.ts`
**依赖：** T1
**步骤：**
1. 无锚点：1000 字符 → 250 tokens。
2. setAnchor(4000, 1000) 后 estimate(8000) → 2000；estimate(2000) → 1000（增量取 0）。
3. resetAnchor 后回到纯字符估算。
4. estimateMessages 对 toolResults / toolUses / 自然语言三种消息的字符口径断言。

**验证：** `bun test tests/context/tokens.test.ts` 全绿。

## T10: 存盘测试

**文件：** `tests/context/spill.test.ts`
**依赖：** T2
**步骤：**
1. 未超阈值：原文原样返回，无文件产生。
2. 超阈值：返回预览（含路径行），文件存在且内容 = 完整原文，文件名匹配 `bash-\d{8}-\d{6}-\w{6}\.txt`。
3. 存盘目录不可写（注入不存在且无法创建的 workDir 模拟失败）：回退原文不抛错。
4. 预览长度断言：500 字符 + 路径行。

**验证：** `bun test tests/context/spill.test.ts` 全绿。

## T11: 摘要测试

**文件：** `tests/context/summarizer.test.ts`
**依赖：** T3
**步骤：**
1. buildSummaryPrompt：system 含「不要调用任何工具」「草稿」；user 含九段标题。
2. truncateForSummary：构造 10 条消息，断言尾部 5 轮保留、头部替换为占位、原数组未被修改。
3. generateSummary：假客户端 yield text_delta「摘要内容」+ stream_end；断言返回 summary、tools 参数为空数组、usage 透传。
4. 截短触发：注入小窗口估算（传入超大待摘要历史），断言发出的消息数 ≤ 截短后条数。

**验证：** `bun test tests/context/summarizer.test.ts` 全绿。

## T12: Compactor 测试

**文件：** `tests/context/compactor.test.ts`
**依赖：** T4
**步骤：**
1. splitHistory：10K token 先于 5 条触发 / 5 条先于 10K 触发两种用例；工具结果消息不占自然语言名额但 token 照算。
2. maintain：估算超「窗口−13K」触发压缩（假 client 返回摘要），替换后历史 = 摘要消息 + recent + 边界消息；未超不触发。
3. applyLightPrevention：单条超 2K 存盘；多条合计超 8K 从最大开始替换至达标。
4. 熔断：假 client 连续抛错 3 次 → circuitOpen=true 且 maintain 不再调用 client；resetFailures 后恢复。
5. compactManually：无阈值直接压；压后 remainingTokens < 3K 在结果中体现。
6. 中断：signal 预先 aborted，runCompaction 不替换历史。

**验证：** `bun test tests/context/compactor.test.ts` 全绿。

## T13: loop 集成测试

**文件：** `tests/agent/loop.test.ts`（追加用例）
**依赖：** T6
**步骤：**
1. 注入小窗口 Compactor + 假 client：脚本第 1 次请求前触发压缩（历史先塞满），断言事件流出现 compaction 事件、历史被替换、后续请求正常。
2. compactor 缺省：现有全部用例行为不变（回归即验证）。
3. 工具结果回灌：脚本产出工具调用，结果超阈值时历史中的结果是预览而非原文。

**验证：** `bun test tests/agent/loop.test.ts` 全绿。

## T14: 全量回归与类型检查

**文件：** 无新增
**依赖：** T1–T13
**步骤：**
1. `bun run typecheck` 零错误。
2. `bun test` 全量通过（原 286 + 新增用例）。

**验证：** 两条命令输出均无错误。

## T15: 端到端手工验证

**文件：** 无新增
**依赖：** T14
**步骤：**
1. 在 typescript/ 下启动 `bun run src/main.tsx`（需有效 provider 配置）。
2. 长对话场景：连续让模型读取大文件，观察工具结果存盘提示与文件生成。
3. `/compact`：手动触发，观察压缩提示与后续对话连贯性。
4. 对照 checklist.md 逐项验收（阶段六）。

**验证：** checklist.md 全项可勾选。

## 执行顺序

```
T1 ──→ T2 ──→ T4 ──┐
 │                  ├─→ T6 ──→ T7 ──→ T13 ──→ T14 ──→ T15
 └─→ T3 ────────────┘
T5（并行）→ T6
T8（并行，任意时机）
T9─T12 随各自实现任务同步编写（T2→T10、T3→T11、T4→T12）
```
