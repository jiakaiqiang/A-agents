# Agent Loop Tasks

共 20 个任务。全部路径相对 `typescript/`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/tools/types.ts` | `Tool.readOnly` 必填；`ToolErrorKind` 增 `cancelled` |
| 修改 | `src/tools/read.ts` | `readOnly: true` |
| 修改 | `src/tools/glob.ts` | `readOnly: true` |
| 修改 | `src/tools/grep.ts` | `readOnly: true` |
| 修改 | `src/tools/write.ts` | `readOnly: false` |
| 修改 | `src/tools/edit.ts` | `readOnly: false` |
| 修改 | `src/tools/bash.ts` | `readOnly: false` |
| 修改 | `src/tools/limits.ts` | 追加三个循环上限常量 |
| 修改 | `src/tools/registry.ts` | `definitionsFor` 只读过滤 + `listReadOnly` |
| 新建 | `src/agent/events.ts` | `AgentEvent` / `StopReason` / `LoopPhase` / `AgentMode` |
| 新建 | `src/agent/collect.ts` | 双路流式收集器 |
| 新建 | `src/agent/batch.ts` | `planBatches` + `runBatches` |
| 新建 | `src/agent/loop.ts` | `runLoop`：ReAct 循环与五种停止条件 |
| 删除 | `src/agent/turn.ts` | 受限两段式，被 `loop.ts` 取代 |
| 修改 | `src/prompt/sections.ts` | `usingToolsSection(tools, mode)` |
| 修改 | `src/prompt/builder.ts` | `BuildOptions.mode` 透传 |
| 修改 | `src/tui/spinner.tsx` | 可选 `iteration` / `phase` |
| 修改 | `src/tui/app.tsx` | 消费事件流 + 模式状态 + 斜杠命令 |
| 修改 | `tests/tools/registry.test.ts` | `fakeTool` 补 `readOnly`；新增只读过滤断言 |
| 删除 | `tests/agent/turn.test.ts` | 断言与本章需求冲突 |
| 新建 | `tests/agent/collect.test.ts` | 双路一致性 / parseError / 取消 |
| 新建 | `tests/agent/batch.test.ts` | 分段 / 并发 / 保序 / 批内失败 / 取消 |
| 新建 | `tests/agent/loop.test.ts` | 五种停止条件 / 配对 / 事件顺序 / 计划模式 |

任务与文件的对应：T1 类型、T2 六工具、T3 上限、T4 注册中心、T5 事件、T6 收集器、
T7+T8 分批、T9–T12 循环、T13 删除旧编排、T14+T15 提示词、T16 Spinner、T17 app.tsx、
T18 既有测试、T19 收集器与分批测试、T20 循环测试。

## T1: 工具类型增加 readOnly 与 cancelled

**文件：** `src/tools/types.ts`
**依赖：** 无
**步骤：**
1. `ToolErrorKind` 联合类型末尾追加 `| "cancelled"`，行内注释说明用于批次被中断时
   未执行的调用。
2. `Tool` 接口在 `parameters` 之后加一行 `readonly readOnly: boolean;`，注释说明
   「无副作用：可与同批工具并发，且计划模式下可用」。
3. 不动 `ok` / `fail` / `stringArg` 等辅助函数。

**验证：** `bun run typecheck` 报出六个工具对象缺少 `readOnly` 的错误——说明必填生效，
错误应为 6 处（read/write/edit/bash/glob/grep）加 `tests/tools/registry.test.ts` 里的
`fakeTool`，共 7 处。

## T2: 六个工具声明 readOnly

**文件：** `src/tools/read.ts`、`glob.ts`、`grep.ts`、`write.ts`、`edit.ts`、`bash.ts`
**依赖：** T1
**步骤：**
1. `read.ts` 的 `ReadTool` 对象在 `parameters` 后加 `readOnly: true,`。
2. `glob.ts` 的 `GlobTool`、`grep.ts` 的 `GrepTool` 同样加 `readOnly: true,`。
3. `write.ts` 的 `WriteTool`、`edit.ts` 的 `EditTool`、`bash.ts` 的 `BashTool`
   加 `readOnly: false,`。
4. 六处都放在 `parameters` 与 `callSummary` 之间，保持字段顺序一致。

**验证：** `bun run typecheck` 中六个工具文件不再报错（`registry.test.ts` 的 `fakeTool`
仍报，留给 T18）。

## T3: 追加循环上限常量

**文件：** `src/tools/limits.ts`
**依赖：** 无
**步骤：**
1. 文件末尾（`IGNORED_DIRS` 之后）加一段注释分隔：`// ── Agent Loop 上限（spec N1）──`。
2. 声明 `export const MAX_ITERATIONS = 25;`，注释「一轮内模型请求次数上限，兜底安全网」。
3. 声明 `export const MAX_INVALID_ITERATIONS = 3;`，注释「连续全部调用未知工具的迭代
   次数阈值」。
4. 声明 `export const MAX_CONCURRENT_TOOLS = 8;`，注释「并发批最大并发度，超出切子批」。

**验证：** `bun -e "import('./src/tools/limits.js').then(m => console.log(m.MAX_ITERATIONS, m.MAX_INVALID_ITERATIONS, m.MAX_CONCURRENT_TOOLS))"`
输出 `25 3 8`。

## T4: 注册中心支持只读子集

**文件：** `src/tools/registry.ts`
**依赖：** T2
**步骤：**
1. 在 `ToolDefinition` 之后导出 `export interface DefinitionOptions { readOnlyOnly?: boolean }`。
2. 新增 `listReadOnly(): Tool[]`，实现为 `this.list().filter((tool) => tool.readOnly)`。
3. `definitionsFor(protocol, options?)` 签名加第二个可选参数；方法体第一行改为
   `const source = options?.readOnlyOnly ? this.listReadOnly() : this.list();`，
   后续 `.map` 改为对 `source` 调用。三协议映射逻辑保持原样不动。

**验证：** `bun test tests/tools/registry.test.ts` 中「三协议导出一致」与「新增第七个
工具」两条仍通过（`fakeTool` 的类型错误在 T18 修，运行期不受影响）。

## T5: 定义事件与停止原因

**文件：** `src/agent/events.ts`（新建）
**依赖：** 无
**步骤：**
1. `import type { UsageInfo } from "../llm/events.js";`。
2. 导出 `export type StopReason = "complete" | "max_iterations" | "cancelled" |
   "invalid_tools" | "stream_error";`，每项后加行内注释标注对应的 spec 编号（F5–F9）。
3. 导出 `export type LoopPhase = "model" | "tools";`。
4. 导出 `export type AgentMode = "execute" | "plan";`。
5. 导出 `export type AgentEvent` 联合类型，八个成员按 plan.md 的定义逐字写出：
   `text` / `thinking` / `tool_start` / `tool_end` / `usage` / `progress` /
   `notice` / `done`。`done` 含 `reason`、`iterations`、`toolsExecuted`、
   `finalText`、可选 `errorMessage`。
6. 文件不 import 任何 `tui/` 或 `tools/` 模块。

**验证：** `bun run typecheck` 该文件无错误；`grep -c "tui" src/agent/events.ts` 为 0。

## T6: 双路流式收集器

**文件：** `src/agent/collect.ts`（新建）
**依赖：** T5
**步骤：**
1. 导出 `CollectedResponse` 接口：`text`、`thinkingBlocks`、`toolUses`（元素为
   `ToolUseBlock & { parseError?: string }`）、`usage`、`stopReason`、`aborted`。
2. 内部 `function isAbort(error: unknown): boolean`，判 `error.name === "AbortError"`
   （可从 `turn.ts` 搬这段逻辑，删除时一并带走）。
3. 导出 `export async function* collectStream(client, conversation, tools, signal):
   AsyncGenerator<AgentEvent, CollectedResponse>`。
4. 函数体：声明 `text`、`thinkingBlocks`、`toolUses`、`usage`、`stopReason` 局部变量；
   `for await (const event of client.stream(conversation, tools, signal))` 内 switch：
   - `text_delta`：`text += event.text` 并 `yield { type: "text", text: event.text }`
   - `thinking_delta`：`yield { type: "thinking", text: event.text }`
   - `thinking_complete`：推入 `thinkingBlocks`，不 yield
   - `tool_call_complete`：推入 `toolUses`，保留 `parseError`
   - `tool_call_start` / `tool_call_delta`：`break`（工具行由 `runBatches` 发出）
   - `stream_end`：`stopReason = event.stopReason`；把 `event.usage` 四个字段累加进
     `usage`。**不 yield usage 事件**，加注释说明累计由 `loop.ts` 负责（F31）。
5. 整个 `for await` 包 `try/catch`：`catch` 中若 `isAbort(error)` 则
   `return { text, thinkingBlocks, toolUses, usage, stopReason, aborted: true }`；
   否则 `throw error`。
6. 正常结束 `return { ..., aborted: false }`。

**验证：** `bun run typecheck` 无错误；生成器的 return 类型被推断为 `CollectedResponse`。

## T7: 分批规划纯函数

**文件：** `src/agent/batch.ts`（新建）
**依赖：** T4、T5
**步骤：**
1. 导出 `PendingCall`（`id`、`name`、`arguments`、可选 `parseError`）与
   `ToolBatch`（`concurrent: boolean`、`calls: PendingCall[]`）。`PendingCall` 的字段
   与 `CollectedResponse.toolUses` 元素结构一致，`loop.ts` 可直接传入不做转换。
2. 导出 `export function planBatches(calls: PendingCall[], registry: ToolRegistry):
   ToolBatch[]`。
3. 实现：`calls` 为空返回 `[]`；`for` 遍历，
   `const isReadOnly = registry.get(call.name)?.readOnly === true;`
   —— 未知工具因 `get` 返回 `undefined` 自然落到 `false`（归串行批）。
4. 只读调用：取 `batches.at(-1)`，若存在且 `concurrent === true` 则 `push` 进其
   `calls`，否则 `batches.push({ concurrent: true, calls: [call] })`。
5. 非只读调用：`batches.push({ concurrent: false, calls: [call] })`。
6. 加行内注释说明不重排、不跨串行批合并（F19）。

**验证：** 临时脚本或直接进 T19 的测试：`[Read, Write, Read, Grep]` 得到
`[{true,[Read]}, {false,[Write]}, {true,[Read,Grep]}]`。

## T8: 批次执行生成器

**文件：** `src/agent/batch.ts`
**依赖：** T7
**步骤：**
1. 内部 `function summaryOf(registry, call): string`：有工具则
   `tool.callSummary(call.arguments)`，否则 `` `${call.name}(...)` ``。
2. 内部 `async function runOne(registry, call, context): Promise<ToolResult>`：
   `call.parseError` 存在时直接返回
   `fail("invalid_params", \`工具 ${call.name} 的参数 JSON 无法解析：${call.parseError}\`)`，
   不进 `runTool`；否则 `return runTool(registry, call.name, call.arguments, context)`。
3. 内部 `function chunk(calls: PendingCall[], size: number): PendingCall[][]`，
   用于并发批超过 `MAX_CONCURRENT_TOOLS` 时切子批。
4. 导出 `export async function* runBatches(batches, registry, context):
   AsyncGenerator<AgentEvent, ToolResultBlock[]>`。
5. 函数体维护 `const results: ToolResultBlock[] = []` 与
   `let cancelled = context.signal?.aborted === true`。
6. 逐批遍历；每批开头刷新 `cancelled ||= context.signal?.aborted === true`。
7. `cancelled` 为真：对该批每个调用 yield `tool_start`，用
   `fail("cancelled", "本轮已中断，该工具调用未执行")` 作结果，yield `tool_end`，
   推入 `results`，`continue`（F22）。
8. 串行批（`concurrent === false`）：yield `tool_start` → `await runOne` →
   yield `tool_end` → 推 `results`。`runOne` 抛 `AbortError` 时置 `cancelled = true`
   并把该调用记为 `fail("cancelled", ...)`，不向上抛（保证配对完整）。
9. 并发批：按 `chunk(calls, MAX_CONCURRENT_TOOLS)` 逐子批处理——先按序 yield 全部
   `tool_start`，再 `await Promise.all(subCalls.map((call) => runOne(...)))`
   （`runOne` 内已兜异常，此处只需处理 `AbortError`：用 `.catch` 转成
   `fail("cancelled", ...)`），最后按原序 yield `tool_end` 并推 `results`。
10. 返回 `results`；下标与输入 `batches` 展平后的顺序严格一致（N6）。

**验证：** `bun run typecheck` 无错误；T19 测试断言并发耗时与结果顺序。

## T9: 循环骨架与自然完成

**文件：** `src/agent/loop.ts`（新建）
**依赖：** T6、T8
**步骤：**
1. 导出 `LoopOptions` 接口：`client`、`conversation`、`registry`、`protocol`、
   `workDir`、`mode: AgentMode`、可选 `signal`、可选 `maxIterations`。
2. 内部 `function addUsage(target: UsageInfo, current: UsageInfo): void`，四个字段
   逐项累加（可从 `turn.ts` 搬）。
3. 导出 `export async function* runLoop(options: LoopOptions):
   AsyncGenerator<AgentEvent>`。
4. 函数体开头解构 options，`const limit = options.maxIterations ?? MAX_ITERATIONS;`，
   初始化 `iterations = 0`、`toolsExecuted = 0`、`invalidStreak = 0`、
   `finalText = ""`、`accumulated = emptyUsage()`、`lastWriteWasToolResult = false`。
5. 写 `while (iterations < limit)` 循环：
   - `iterations += 1`；yield `{ type: "progress", iteration: iterations,
     phase: "model", toolsExecuted }`
   - `const tools = registry.definitionsFor(protocol, { readOnlyOnly: mode === "plan" })`
   - `const response = yield* collectStream(client, conversation, tools, signal)`
   - `addUsage(accumulated, response.usage)`；yield `{ type: "usage", usage: { ...accumulated } }`
   - `finalText = response.text`
   - `response.toolUses.length === 0` 时：`if (finalText)
     conversation.addAssistantMessage(finalText)`；`lastWriteWasToolResult = false`；
     跳出循环并以 `complete` 收尾。
6. 本任务只实现自然完成路径，其余分支留给 T10–T12；先用 `break` 占位使类型完整。
7. 循环外调用内部 `stop` 辅助（T12 实现）产出 `done` 事件。

**验证：** `bun run typecheck` 无错误；T20 的「无工具时只请求一次」用例通过。

## T10: 工具迭代与历史配对

**文件：** `src/agent/loop.ts`
**依赖：** T9
**步骤：**
1. 在 `toolUses.length === 0` 分支之后补有工具分支。
2. 先处理取消：`if (response.aborted)` → 把 `toolUses` 原样写入历史
   （`conversation.addAssistantFull(response.text, response.thinkingBlocks, 去掉
   parseError 的调用)`），再为每个调用写 `fail("cancelled", ...)` 结果消息，
   `lastWriteWasToolResult = true`，以 `cancelled` 收尾。
3. 正常有工具：`const historyTools = response.toolUses.map(({ parseError: _p, ...rest })
   => rest);`；`conversation.addAssistantFull(response.text, response.thinkingBlocks,
   historyTools)`。
4. 若 `response.text` 非空，先把它当作本次迭代正文——不额外处理，界面已通过 `text`
   事件累积。
5. yield `{ type: "progress", iteration: iterations, phase: "tools", toolsExecuted }`。
6. `const batches = planBatches(response.toolUses, registry);`
7. `const results = yield* runBatches(batches, registry, { workDir, signal });`
8. `toolsExecuted += results.filter((item) => !item.isError).length` —— 注释说明只统计
   真正执行成功的调用数，`unknown_tool` / `cancelled` / `invalid_params` 不计入。
9. `conversation.addToolResultMessage(results)`；`lastWriteWasToolResult = true`。
10. 断言性注释：`results.length === response.toolUses.length` 恒成立（F3）。

**验证：** T20 的「三次工具后自然完成」用例通过：`iterations === 4`，历史中每条
`toolUses` 都有紧随的 `toolResults` 且 `toolUseId` 一一对应。

## T11: 无效迭代与取消检查点

**文件：** `src/agent/loop.ts`
**依赖：** T10
**步骤：**
1. 在 `addToolResultMessage` 之后判无效迭代：
   `const allUnknown = response.toolUses.every((call) => !registry.get(call.name));`
   为真则 `invalidStreak += 1`，否则 `invalidStreak = 0`。加注释说明「全部未知才计数，
   混合不计」（F8）。
2. `if (invalidStreak >= MAX_INVALID_ITERATIONS)` → 以 `invalid_tools` 收尾。
3. 在三处插入取消检查（F7）：
   - 循环体最开头：`if (signal?.aborted)` → 以 `cancelled` 收尾
   - `collectStream` 返回后：`response.aborted` 为真的分支已在 T10 覆盖；此处补
     无工具且 `aborted` 的情况（把已收文本写入历史后以 `cancelled` 收尾）
   - `runBatches` 返回后：`if (signal?.aborted)` → 以 `cancelled` 收尾
4. `while` 条件正常退出（`iterations >= limit` 且上一次迭代有工具）时以
   `max_iterations` 收尾。

**验证：** T20 的「连续未知工具」「永远请求工具撞上限」「三阶段取消」四条用例通过。

## T12: 停止收尾与错误兜底

**文件：** `src/agent/loop.ts`
**依赖：** T11
**步骤：**
1. 内部 `function closingText(reason: StopReason, iterations: number): string`，
   按原因返回收尾文本，例如 `max_iterations` → `` `（已达到本轮迭代上限 ${iterations}
   轮，任务可能未完成）` ``；`cancelled` → `（本轮已被用户中断）`；`invalid_tools` →
   `（模型连续请求不存在的工具，本轮已中止）`；`stream_error` → `（本轮因请求错误中止）`。
2. 内部 `function noticeText(reason, iterations): string`，界面提示文案，措辞与
   `closingText` 区分开（F30）。
3. 把收尾逻辑集中成一个局部生成器 `function* finish(reason, errorMessage?)`：
   - `reason !== "complete" && lastWriteWasToolResult` 时
     `conversation.addAssistantMessage(closingText(reason, iterations))`（F4）
   - `reason !== "complete"` 时 yield `{ type: "notice", text: noticeText(...),
     isError: reason !== "cancelled" }`
   - yield `{ type: "done", reason, iterations, toolsExecuted, finalText,
     ...(errorMessage ? { errorMessage } : {}) }`
4. 整个 `while` 循环包在 `try/catch` 中：`catch (error)` 里
   `isAbort(error)` → `yield* finish("cancelled")`；否则
   `yield* finish("stream_error", error instanceof Error ? error.message : String(error))`
   （F9/N5）。
5. 各停止分支改为 `return yield* finish(reason)`，确保 `done` 是最后一个事件（F13）。
6. 确认文件不 import 任何 `tui/` 模块。

**验证：** `grep -rn "tui" src/agent/` 无输出；T20 的「流错误」「收尾消息后可继续下一轮」
两条用例通过。

## T13: 删除受限两段式

**文件：** `src/agent/turn.ts`、`tests/agent/turn.test.ts`
**依赖：** T12
**步骤：**
1. 确认 `src/agent/loop.ts` 已覆盖 `turn.ts` 中需要保留的两段逻辑（`isAbort`、
   `addUsage`），若尚未搬移则先补齐。
2. 删除 `src/agent/turn.ts`。
3. 删除 `tests/agent/turn.test.ts`。
4. `grep -rn "turn.js\|runTurn\|TurnCallbacks" src tests` 确认无残留引用
   （`app.tsx` 的引用在 T17 一并处理；若此时仍在，T17 完成后复查）。

**验证：** `bun run typecheck` 除 `app.tsx` 尚未改造导致的 `runTurn` 缺失错误外无其他
错误；该错误在 T17 消除。

## T14: 提示词支持多工具与计划模式

**文件：** `src/prompt/sections.ts`
**依赖：** T5
**步骤：**
1. `import type { AgentMode } from "../agent/events.js";` —— 只导入类型，不产生运行时
   依赖。
2. `usingToolsSection` 签名改为 `(tools: ToolSummary[] = [], mode: AgentMode = "execute")`。
3. 删除约束里的「每轮最多执行一个工具调用；需要多步操作时，先完成一步并在下一轮继续。」
   一行（F1）。
4. 在其位置写入「可以在一轮内连续调用多个工具，根据每次结果决定下一步，直到任务完成。」
5. 保留既有两条约束（相对路径不越界、改文件前先 Read）。
6. `mode === "plan"` 时在数组末尾追加一段：标题「计划模式」，内容说明只能读取信息、
   不要尝试修改文件或执行命令、应当产出一份可执行的计划文本、用户切到执行模式后再动手
   （F26）。
7. 工具列表为空时的回退文案保持不变（N4）。

**验证：** `bun -e` 内联调用 `usingToolsSection([{name:"Read",description:"d"}], "plan")`
输出含「计划模式」且不含「每轮最多」；同一调用传 `"execute"` 时不含「计划模式」。

## T15: builder 透传模式

**文件：** `src/prompt/builder.ts`
**依赖：** T14
**步骤：**
1. `BuildOptions` 增 `mode?: AgentMode`（`import type` 自 `../agent/events.js`）。
2. `buildSystemPrompt` 中 `usingToolsSection(options.tools ?? [])` 改为
   `usingToolsSection(options.tools ?? [], options.mode ?? "execute")`。
3. 其余 section 顺序与优先级不动。

**验证：** `bun -e` 调用 `buildSystemPrompt(detectEnvironment(process.cwd()),
{ tools:[{name:"Read",description:"d"}], mode:"plan" })`，输出含「计划模式」。

## T16: Spinner 显示迭代与阶段

**文件：** `src/tui/spinner.tsx`
**依赖：** T5
**步骤：**
1. props 增可选 `iteration?: number` 与 `phase?: LoopPhase`（`import type` 自
   `../agent/events.js`）。
2. 在 token 那段 `<Text color={brand.muted}>` 之前插入一段条件渲染：`iteration` 有值时
   显示 `` ` (第 ${iteration} 轮 · ${phase === "tools" ? "执行工具" : "等待模型"})` ``。
3. 两个 prop 都缺省时渲染结果与改造前完全一致（N4）。

**验证：** `bun run typecheck` 无错误；用 tmux 端到端观察时可见轮次递增。

## T17: app.tsx 消费事件流

**文件：** `src/tui/app.tsx`
**依赖：** T12、T15、T16
**步骤：**
1. import 改为 `import { runLoop } from "../agent/loop.js";` 与
   `import type { AgentEvent, AgentMode, LoopPhase } from "../agent/events.js";`，
   删除 `runTurn` 的 import。
2. 新增状态：`mode`（`useState<AgentMode>("execute")`）、`iteration`
   （`useState(0)`）、`phase`（`useState<LoopPhase>("model")`）。
3. systemPrompt 的 `useEffect` 依赖数组加 `mode`；`toolSummaries` 改为按模式取
   `mode === "plan" ? registryRef.current.listReadOnly() : registryRef.current.list()`；
   `buildSystemPrompt(env, { tools: toolSummaries, mode })`。
4. `handleSubmit` 开头在 `/exit` 之后加两个分支：`/plan` → `setMode("plan")` +
   push 一条 `{ role: "system", content: "已切换到计划模式：仅只读工具可用，模型将先产出
   计划" }` + `return`；`/do` → `setMode("execute")` + 对应提示 + `return`。两者都不调
   `conversationRef.current.addUserMessage`、不设 `isStreaming`（F25/AC29）。
5. `runAgentLoop` 重写为 `for await (const event of runLoop({ client, conversation:
   conversationRef.current, registry: registryRef.current, protocol:
   selectedProvider.protocol, workDir, mode, signal: abortControllerRef.current?.signal }))`，
   内部 `switch (event.type)` 按 plan.md 的映射处理八类事件。
6. 局部 `let buffer = ""` 与 `function flushBuffer()`：把 `buffer` 非空时作为一条
   `{ role: "assistant", content: buffer }` push 进 `messages`，然后清空 `buffer`、
   `setStreamingText("")`（F28）。
7. `progress` 事件：`event.phase === "tools"` 时先 `flushBuffer()`；再
   `setIteration(event.iteration)`、`setPhase(event.phase)`。
8. `done` 事件：`flushBuffer()`；`complete` → `setCompletionMark(randomCompletionVerb())`；
   `stream_error` → `setError(event.errorMessage ?? "请求失败")`；其余三种依赖 `notice`
   事件已 push 的 system 消息，不重复提示。随后 `committedIndexRef.current =
   messages.length`（沿用既有写法）。
9. `<Spinner>` 传 `iteration={iteration}` 与 `phase={phase}`；`<StatusBar>` 传
   `mode={mode === "plan" ? "计划" : "执行"}`（F27）。
10. `finally` 中重置 `isStreaming`、`streamingText`、`abortControllerRef`、
    `setIteration(0)`。

**验证：** `bun run typecheck` 全项目无错误；`bun run start` 启动后输入 `/plan` 状态栏
模式变为「计划」且不发请求。

## T18: 修正既有工具测试

**文件：** `tests/tools/registry.test.ts`
**依赖：** T4
**步骤：**
1. `fakeTool` 对象加 `readOnly: true`（它是无副作用的测试工具）。
2. 新增一条 test「只读过滤只导出读类工具」：`createDefaultRegistry()` 的
   `definitionsFor("anthropic", { readOnlyOnly: true })` 长度为 3；
   名称集合等于 `["Read", "Glob", "Grep"]`（注意注册顺序为
   Read/Write/Edit/Bash/Glob/Grep，过滤后顺序为 Read/Glob/Grep）。
3. 新增断言：`registry.listReadOnly().map(t => t.name)` 与上一步一致；
   `registry.list().filter(t => !t.readOnly).map(t => t.name)` 等于
   `["Write", "Edit", "Bash"]`（AC19）。

**验证：** `bun test tests/tools/registry.test.ts` 全部通过。

## T19: 收集器与分批测试

**文件：** `tests/agent/collect.test.ts`、`tests/agent/batch.test.ts`（新建）
**依赖：** T6、T8
**步骤：**
1. `collect.test.ts`：写 `fakeClient(events: StreamEvent[])` 生成器桩。
   - 用例一（AC16）：脚本含两段 `text_delta` + `stream_end`，把 yield 出的 `text`
     事件拼接，断言与 `CollectedResponse.text` 完全一致。
   - 用例二（AC17）：脚本含 `thinking_complete`、`tool_call_complete`（带
     `parseError`）、`stream_end`，断言 `thinkingBlocks` 长度、`toolUses[0].parseError`
     存在、`stopReason` 与 `usage` 正确。
   - 用例三：脚本 yield 一个 `text_delta` 后 throw `AbortError`，断言 `aborted === true`
     且已收文本保留、不抛出。
   - 用例四：断言收集器不产出 `usage` 类型事件（该职责在 loop）。
2. `batch.test.ts`：用 `createDefaultRegistry()` 与自造的可控 `Tool` 桩。
   - 用例一（AC20）：`[Read, Write, Read, Grep]` → `planBatches` 结果为
     `[{concurrent:true,calls:[Read]}, {concurrent:false,calls:[Write]},
     {concurrent:true,calls:[Read,Grep]}]`。
   - 用例二（AC21）：全只读 → 一个并发批；全副作用 → 三个串行批。
   - 用例三：未知工具名 → 单独串行批。
   - 用例四（AC22）：注册两个各 sleep 60ms 的只读桩工具，`runBatches` 一个并发批，
     断言总耗时 < 120ms 且结果顺序与输入顺序一致。
   - 用例五（AC23）：并发批内一个桩工具 throw，断言同批另一个仍返回 `ok`，
     且失败那条 `errorKind === "exec_failed"`。
   - 用例六（AC24）：串行批先 Write 再 Read 同一临时文件，断言 Read 结果含新内容
     （用 `mkdtempSync` 建临时目录，`afterEach` 清理）。
   - 用例七（F22）：传入已 `abort()` 的 signal，断言全部调用都产出
     `errorKind === "cancelled"` 结果且 `tool_start` / `tool_end` 事件数与调用数相等。

**验证：** `bun test tests/agent/collect.test.ts tests/agent/batch.test.ts` 全部通过。

## T20: 循环测试

**文件：** `tests/agent/loop.test.ts`（新建）
**依赖：** T12、T19
**步骤：**
1. 搬 `turn.test.ts` 的 `fakeClient(scripts, receivedTools)` 桩并改造：每次 `stream`
   调用记录收到的 `tools` 并 yield 对应脚本。
2. 辅助 `collect(options): Promise<AgentEvent[]>`：把 `runLoop` 的事件收成数组。
3. 用例（编号对应 spec AC）：
   - AC1：脚本一段纯文本 → `done.iterations === 1`、`reason === "complete"`、
     `toolsExecuted === 0`，历史末尾为 assistant 消息。
   - AC2/AC3：三次含工具、第四次纯文本 → `iterations === 4`、`toolsExecuted === 3`；
     遍历历史断言每条带 `toolUses` 的消息后紧跟一条 `toolResults`，两侧 id 列表相等。
   - AC4/AC12：`fakeClient` 永远 yield 工具调用，`maxIterations: 5` →
     `iterations === 5`、`reason === "max_iterations"`，`receivedTools.length === 5`。
   - AC5：接上一条，断言历史最后一条为 assistant 且内容含「迭代上限」；随后
     `conversation.addUserMessage("继续")` 后 `buildAnthropicMessages(getMessages())`
     不出现相邻两条 `role === "user"`。
   - AC8：脚本第一段 throw `AbortError` → `reason === "cancelled"`、无异常抛出。
   - AC9：signal 在工具阶段前 abort → 全部调用结果为 `cancelled` 且与 `toolUses` 配对。
   - AC10：连续三次全部调用未知工具 → `reason === "invalid_tools"`、
     `iterations === 3`；另一用例中第二次迭代混入一个真工具 → 连续计数归零、循环继续。
   - AC11：脚本 throw 普通 `Error("boom")` → `reason === "stream_error"`、
     `done.errorMessage` 含 `boom`，无异常逃出。
   - AC14：一轮含工具的运行中，事件类型集合覆盖 `text`/`tool_start`/`tool_end`/
     `usage`/`progress`/`notice` 或 `done`。
   - AC15：断言同一迭代内 `progress` 的下标小于该迭代首个 `text`/`tool_start` 的下标；
     同一 `toolId` 的 `tool_start` 下标小于 `tool_end`；`done` 为数组最后一项。
   - AC27/AC28：`mode: "plan"` 运行一轮，断言 `receivedTools[0]` 长度为 3 且名称为
     Read/Glob/Grep；`mode: "execute"` 时为 6。
   - AC35：多次迭代后 `usage` 事件的最后一个值等于各次请求用量之和。
   - AC38（AC13 对应）：`grep -rn "from \"../tui" src/agent/` 无输出（写成一条
     读文件断言或留给 checklist 验证）。

**验证：** `bun test` 全绿；`bun run typecheck` 无错误。

## 执行顺序

```text
T1 → T2 ─┐
T3 ──────┼→ T4 → T7 → T8 ─┐
T5 ──────┴→ T6 ───────────┼→ T9 → T10 → T11 → T12 → T13
T5 → T14 → T15 ───────────┘                            │
T5 → T16 ──────────────────────────────────────────────┤
                                                        ↓
                                              T17（app.tsx 收口）
T4 → T18（可与 T5–T16 并行）
T6/T8 → T19（可在 T9 之后随时进行）
T12 → T20
最后：T18 + T19 + T20 全跑 → bun test + bun run typecheck
```

