# Agent Loop Plan

## 技术栈

沿用前两章技术栈，本章不新增任何第三方依赖：

- 运行时：bun；语言 TypeScript 5.x，`strict` + `verbatimModuleSyntax`，相对导入带 `.js`
- TUI：Ink 5.x（复用既有 `ChatMessage` 渲染管线与 `<Static>` 提交机制）
- LLM SDK：`@anthropic-ai/sdk`、`openai`（三个 client 的流式解析已可用，本章不改）
- 并发：原生 `Promise.all`，不引入并发池库
- 事件流：原生 `AsyncGenerator`，不引入 EventEmitter / RxJS
- 测试：`bun test`；类型检查 `tsc --noEmit`

## 架构概览（分层）

在第二章八层结构上改动第 7、8 层，其余层保持不变：

1. 入口层 `src/main.tsx` —— 不变。
2. 配置层 `src/config/config.ts` —— 不变。
3. 提示词层 `src/prompt/` —— `usingToolsSection` 改为接收模式参数（F1、F26）。
4. 工具层 `src/tools/` —— `Tool` 增 `readOnly` 声明（F18）；`limits.ts` 增三个循环上限
   （N1）；`registry.definitionsFor` 增只读子集过滤（F24）。六个工具实现体不动。
5. LLM 协议层 `src/llm/` —— **完全不变**。三个 client 已产出统一 `StreamEvent`。
6. 会话层 `src/conversation/conversation.ts` —— **完全不变**。
7. **编排层 `src/agent/`（重写）** —— `turn.ts` 的受限两段式删除，替换为
   `loop.ts`（ReAct 循环）+ `collect.ts`（双路收集器）+ `batch.ts`（分批调度）
   + `events.ts`（事件定义）。不引用 Ink / React。
8. TUI 层 `src/tui/` —— `app.tsx` 改为消费事件流并维护模式状态。

依赖方向仍严格单向：`tools` ← `agent` ← `tui`。`agent` 层新增的四个文件互相只依赖
`events.ts`，不反向依赖 `tui`。

## 数据流（一轮对话）

```text
[用户提交]
  handleSubmit(text)
    ├─ text === "/plan" → setMode("plan")  → 提示 + return（不进历史、不发请求）
    ├─ text === "/do"   → setMode("execute") → 提示 + return
    └─ 普通文本 → conv.addUserMessage(text) → for await (event of runLoop({...}))

[runLoop —— 迭代 i = 1..MAX_ITERATIONS]
  yield { type:"progress", iteration:i, phase:"model" }
  response = yield* collectStream(client, conv, toolsFor(mode), signal)
      ├─ text_delta      → yield { type:"text" }        （双路：实时推）
      ├─ thinking_delta  → yield { type:"thinking" }
      ├─ tool_call_*     → 累积到 response.toolUses      （双路：攒完整）
      └─ stream_end      → 记入 response.usage（不在此 yield）
  addUsage(accumulated, response.usage)
  yield { type:"usage", usage: accumulated }            // 本轮累计值（F31）

  ├─ response.aborted            → stop("cancelled")
  ├─ response.toolUses.length===0 → conv.addAssistantMessage(text) → stop("complete")
  └─ 有工具调用：
       conv.addAssistantFull(text, thinking, toolUses)
       yield { type:"progress", iteration:i, phase:"tools" }
       batches = planBatches(toolUses, registry)        // 保序分段
       results = yield* runBatches(batches, registry, ctx)
            ├─ 并发批：先 yield 全部 tool_start → Promise.all → 按原序 yield tool_end
            └─ 串行批：yield tool_start → await → yield tool_end
       conv.addToolResultMessage(results)               // 与 toolUses 一一配对
       ├─ 本次全部调用均为未知工具 → invalidStreak++ ；否则 invalidStreak = 0
       ├─ invalidStreak >= MAX_INVALID_ITERATIONS → stop("invalid_tools")
       └─ 继续下一次迭代

[循环出口]
  i > MAX_ITERATIONS               → stop("max_iterations")
  signal.aborted（迭代间检查）      → stop("cancelled")
  catch(非 AbortError)             → stop("stream_error", message)

[stop(reason)]
  ├─ reason !== "complete" 且历史末尾是工具结果 → conv.addAssistantMessage(收尾说明)  // F4
  ├─ reason !== "complete" → yield { type:"notice", ... }
  └─ yield { type:"done", reason, iterations, toolsExecuted, finalText, errorMessage? }
```

## 核心数据结构与接口

```ts
// ───────── src/agent/events.ts（新增） ─────────
export type StopReason =
  | "complete"        // 模型不再请求工具（F5）
  | "max_iterations"  // 达到迭代上限（F6）
  | "cancelled"       // 用户取消（F7）
  | "invalid_tools"   // 连续无效迭代（F8）
  | "stream_error";   // 流错误（F9）

export type LoopPhase = "model" | "tools";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; toolId: string; name: string; argSummary: string }
  | { type: "tool_end"; toolId: string; ok: boolean; summary: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "progress"; iteration: number; phase: LoopPhase; toolsExecuted: number }
  | { type: "notice"; text: string; isError: boolean }
  | {
      type: "done";
      reason: StopReason;
      iterations: number;      // 已发起的模型请求次数
      toolsExecuted: number;
      finalText: string;
      errorMessage?: string;   // reason === "stream_error" 时携带
    };

// ───────── src/agent/collect.ts（新增） ─────────
export interface CollectedResponse {
  text: string;
  thinkingBlocks: ThinkingBlock[];
  toolUses: Array<ToolUseBlock & { parseError?: string }>;
  usage: UsageInfo;
  stopReason: string;
  aborted: boolean;
}

/** 双路收集器：yield 出事件，return 出完整响应（F15/F16）。 */
export async function* collectStream(
  client: LLMClient,
  conversation: ConversationManager,
  tools: Record<string, unknown>[],
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, CollectedResponse>;

// ───────── src/agent/batch.ts（新增） ─────────
export interface PendingCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  parseError?: string;
}

export interface ToolBatch {
  concurrent: boolean;    // true = 批内并发；false = 单调用串行批
  calls: PendingCall[];
}

/** 保序分段：相邻只读调用合并为并发批，副作用调用各自成串行批（F19）。纯函数。 */
export function planBatches(calls: PendingCall[], registry: ToolRegistry): ToolBatch[];

/** 按批次顺序执行，yield 工具事件，return 按原始顺序排列的结果（F20/F21/F22）。 */
export async function* runBatches(
  batches: ToolBatch[],
  registry: ToolRegistry,
  context: ToolContext,
): AsyncGenerator<AgentEvent, ToolResultBlock[]>;

// ───────── src/agent/loop.ts（新增，替换 turn.ts） ─────────
export type AgentMode = "execute" | "plan";

export interface LoopOptions {
  client: LLMClient;
  conversation: ConversationManager;
  registry: ToolRegistry;
  protocol: ProviderProtocol;
  workDir: string;
  mode: AgentMode;
  signal?: AbortSignal;
  maxIterations?: number;   // 缺省取 MAX_ITERATIONS，测试可覆盖
}

/** 唯一对外入口：产出事件流，最后一个事件必为 done（F11/F13）。 */
export async function* runLoop(options: LoopOptions): AsyncGenerator<AgentEvent>;

// ───────── src/tools/types.ts（改动） ─────────
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchemaObject;
  /** 无副作用：可与同批工具并发（F18），且计划模式下可用（F24）。 */
  readonly readOnly: boolean;
  callSummary(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

// ToolErrorKind 增一项，用于批次中断（F22）
export type ToolErrorKind = /* 既有 8 项 */ | "cancelled";

// ───────── src/tools/registry.ts（改动） ─────────
export interface DefinitionOptions {
  readOnlyOnly?: boolean;   // true 时只导出 readOnly 工具
}
definitionsFor(protocol: ProviderProtocol, options?: DefinitionOptions): ToolDefinition[];

// ───────── src/tools/limits.ts（改动，追加） ─────────
export const MAX_ITERATIONS = 25;          // 迭代上限兜底（F2/N1）
export const MAX_INVALID_ITERATIONS = 3;   // 连续无效迭代阈值（F8/N1）
export const MAX_CONCURRENT_TOOLS = 8;     // 并发批最大并发度（N1）

// ───────── src/prompt/sections.ts（改动） ─────────
export const usingToolsSection: (tools: ToolSummary[], mode?: AgentMode) => Section;
// BuildOptions 增 mode?: AgentMode
```

## 模块设计

### 模块 `src/agent/events.ts`

- 职责：事件与停止原因的唯一定义处。纯类型 + 零运行时逻辑（除类型守卫）。
- 依赖：`llm/events.js` 的 `UsageInfo`。不依赖 `tui`、不依赖 `tools`。
- 说明：`done` 事件同时承载停止原因与本轮统计，取代第二章的 `TurnOutcome` 返回值——
  因为生成器的 `return` 值在 `for await` 中拿不到，必须走事件（F10/N9）。

### 模块 `src/agent/collect.ts`

- 职责：消费一次 `client.stream`，同时做实时推送与完整累积（F15）。
- 关键行为：
  1. `text_delta` → 累加到 `text` 且 `yield { type:"text" }`；`thinking_delta` 同理。
  2. `thinking_complete` → 推入 `thinkingBlocks`（不 yield，界面不展示思考块）。
  3. `tool_call_complete` → 推入 `toolUses`，保留 `parseError`（F17）。
  4. `tool_call_start` / `tool_call_delta` → 忽略：工具行由 `runBatches` 在真正执行前
     统一发出，避免"参数还没解析完就画行"导致摘要为空。
  5. `stream_end` → 记 `stopReason` 与本次 `usage`。**不 yield usage 事件**：用量事件
     由 `loop.ts` 累加后发出，保证界面拿到的是本轮累计值（F31）。
  6. `catch`：`AbortError` → `return { ...已收内容, aborted: true }`（不抛，让循环走
     取消路径）；其余错误原样抛出，由 `loop.ts` 兜成 `stream_error`。
- 依赖：`llm/client.js`（仅接口）、`conversation`、`events.js`。

### 模块 `src/agent/batch.ts`

- 职责：分批规划（纯函数）与批次执行（生成器）。
- `planBatches(calls, registry)`：
  1. 空数组 → 返回 `[]`。
  2. 顺序扫描，`isReadOnly = registry.get(call.name)?.readOnly === true`。
  3. 只读调用：若上一批是并发批则追加进去，否则新开一个并发批。
  4. 非只读调用（含未知工具、含 `parseError` 的调用）：单独新开一个串行批。
  5. 不做任何重排、不跨串行批合并（F19）。
- `runBatches(batches, registry, context)`：
  1. 逐批处理；每批开始前检查 `context.signal?.aborted`。
  2. 已取消 → 该批及后续所有调用生成 `fail("cancelled", ...)` 结果，仍 yield
     `tool_start` + `tool_end` 保证界面与历史都完整（F22）。
  3. 并发批：先按序 `yield tool_start`（摘要取 `registry.get(name)?.callSummary(args)`，
     未知工具回退 `name(...)`）→ `Promise.all(calls.map(runOne))` →
     按原序 `yield tool_end`。
  4. 串行批：`yield tool_start` → `await runOne` → `yield tool_end`。
  5. `runOne(call)`：`call.parseError` 存在 → 直接 `fail("invalid_params", ...)`
     不进 `runTool`；否则 `runTool(registry, name, args, context)`。
  6. 结果数组下标与 `calls` 原始顺序一一对应，返回给 `loop.ts` 直接回写（N6）。
  7. `MAX_CONCURRENT_TOOLS`：并发批内调用数超过该值时按该值切成多个并发子批依次跑，
     子批之间仍保序（防模型一次返回几十个读调用打满文件句柄）。
- 依赖：`tools/execute.js`、`tools/registry.js`、`tools/types.js`、`events.js`。

### 模块 `src/agent/loop.ts`

- 职责：ReAct 循环主体（F1–F10），本章唯一对外入口。
- 内部状态：`iterations`、`toolsExecuted`、`invalidStreak`、`accumulatedUsage`、
  `finalText`、`lastWriteWasToolResult`（供 F4 判断是否需要补收尾消息）。
- 主流程：见"数据流"一节。关键正确性点：
  1. **每次迭代都重新取工具定义**：`registry.definitionsFor(protocol, { readOnlyOnly:
     mode === "plan" })`。模式在一轮内不变，但取值放在循环内可保证与 `mode` 一致，
     避免将来支持轮内切换时漏改。
  2. **配对不变式**（F3）：`toolUses` 与 `runBatches` 返回的结果长度必然相等（
     `runBatches` 对每个调用都产出一条结果），写历史时按下标配对。
  3. **无效迭代判定**（F8）：`toolUses.every(c => !registry.get(c.name))` 为真时
     `invalidStreak++`，否则归零。注意"全部未知"才算无效，混合情况不算。
  4. **收尾消息**（F4）：`stop()` 中若 `reason !== "complete"` 且最后一次写入是工具
     结果消息，则 `conversation.addAssistantMessage(收尾文本)`。收尾文本按停止原因
     区分，例如"（已达到本轮迭代上限，任务未完成）"。这是下一轮请求不 400 的前提。
  5. **取消检查点**：迭代开头、`collectStream` 返回后、`runBatches` 返回后各查一次
     `signal.aborted`（F7 的三个阶段）。
  6. **异常兜底**（F9/N5）：整个循环体包在 `try/catch`；`AbortError` → `cancelled`，
     其余 → `stream_error` 并把 message 放进 `done.errorMessage`。
- 依赖：`collect.js`、`batch.js`、`events.js`、`tools/*`、`conversation`、
  `llm/client.js`（仅接口）。**不 import 任何 `tui/` 模块**（AC13）。

### 模块 `src/tools/types.ts`（改动）

- `Tool` 增必填 `readOnly: boolean`。六个工具各自声明：
  `Read` / `Glob` / `Grep` → `true`；`Write` / `Edit` / `Bash` → `false`。
- `ToolErrorKind` 增 `"cancelled"`，用于 F22 未执行调用的结果分类。
- 其余不动。

### 模块 `src/tools/registry.ts`（改动）

- `definitionsFor(protocol, options?)`：在既有三协议映射前先按
  `options?.readOnlyOnly` 过滤 `this.list()`。三协议的映射逻辑不变（第二章 AC3 仍成立）。
- 新增 `listReadOnly(): Tool[]`，供提示词层派生计划模式工具清单（N7）。

### 模块 `src/tools/limits.ts`（改动）

- 追加 `MAX_ITERATIONS` / `MAX_INVALID_ITERATIONS` / `MAX_CONCURRENT_TOOLS` 三项，
  与既有工具上限同文件（N1 要求"放在一处"）。依赖方向不变：`agent` 本就依赖 `tools`。

### 模块 `src/prompt/sections.ts`（改动）

- `usingToolsSection(tools, mode = "execute")`：
  - 删除"每轮最多执行一个工具调用；需要多步操作时，先完成一步并在下一轮继续"（F1）。
  - 改为："可以在一轮内连续调用多个工具，根据结果决定下一步，直到任务完成。"
  - `mode === "plan"` 时追加计划模式约束段（F26）：只能读取信息、不要尝试修改文件或
    执行命令、应当产出一份可执行的计划文本、用户确认后会切到执行模式。
  - 工具清单仍由传入的 `tools` 派生；计划模式下 `app.tsx` 传入的是只读子集（N7）。
- `builder.ts`：`BuildOptions` 增 `mode?: AgentMode`，透传给 `usingToolsSection`。

### 模块 `src/tui/app.tsx`（改动）

- 新增状态：`const [mode, setMode] = useState<AgentMode>("execute")`。
- `handleSubmit` 先拦斜杠命令（F25/AC29）：`/plan` → `setMode("plan")` + push 一条
  system 提示 + `return`；`/do` 同理。不写会话历史、不发请求。
- systemPrompt 的 `useEffect` 增加 `mode` 依赖：模式切换后重建 client，使新模式的
  提示词与工具清单同时生效（F26）。传入的 `tools` 按模式取
  `registry.list()` 或 `registry.listReadOnly()`。
- `runAgentLoop` 改为消费事件流：

  ```tsx
  for await (const event of runLoop({ ...opts, mode })) {
    switch (event.type) {
      case "text":      buffer += event.text; setStreamingText(buffer); break;
      case "progress":  if (event.phase === "tools") flushBuffer();     // F28
                        setIteration(event.iteration); setPhase(event.phase); break;
      case "tool_start": push({ role:"tool_use", toolId, content:`◆ ${argSummary}` }); break;
      case "tool_end":   patchByToolId(event.toolId, event.summary, !event.ok); break;
      case "usage":      setInputTokens(...); setOutputTokens(...); break;   // 累计值
      case "notice":     push({ role:"system", content, isError }); break;
      case "done":       flushBuffer(); handleStop(event); break;
    }
  }
  ```

- `flushBuffer()`：把当前 `streamingText` 作为一条 `assistant` 消息 push 进 `messages`
  并清空缓冲——这样每次迭代的正文都留在界面上，不被下一次迭代的流式文本覆盖（F28）。
- `handleStop(event)`：`complete` 时设完成动词；`stream_error` 时 `setError(errorMessage)`；
  其余三种 push 一条 system 消息（措辞按原因区分，F30）。
- `<Spinner>` 增 `iteration` / `phase` 两个可选 props（F29）。
- `<StatusBar>` 的既有 `mode` prop 传入中文模式名（F27）。
- 删除对 `runTurn` 的引用。

### 模块 `src/tui/spinner.tsx`（改动）

- 增可选 `iteration?: number`、`phase?: LoopPhase`；有值时在动词后追加
  `(第 N 轮 · 等待模型)` / `(第 N 轮 · 执行工具)`。无值时渲染与现在完全一致（N4）。

### 模块 `src/agent/turn.ts`（删除）

- 受限两段式被 `loop.ts` 完全取代，保留会造成两份编排逻辑。同步删除
  `tests/agent/turn.test.ts`（其断言"每轮仅一个工具""不产生第三次请求"与本章需求直接
  冲突）。

## 模块交互

### 一轮多迭代时序（模型先读再写再收尾）

```text
handleSubmit("把 config 里的超时改成 30 秒")
  └─ runLoop({ mode: "execute", ... })
       ├─ progress{i=1, phase:"model"}
       ├─ collectStream(client, conv, defs(execute))        // 6 个工具定义
       │    → CollectedResponse{ toolUses:[Grep, Read] }
       ├─ conv.addAssistantFull("", [], [Grep, Read])
       ├─ progress{i=1, phase:"tools"}                      // TUI flushBuffer()
       ├─ planBatches([Grep, Read]) → [ {concurrent:true, calls:[Grep, Read]} ]
       ├─ runBatches
       │    ├─ tool_start(Grep) → tool_start(Read)
       │    ├─ Promise.all([runTool(Grep), runTool(Read)])
       │    └─ tool_end(Grep) → tool_end(Read)              // 原序
       ├─ conv.addToolResultMessage([R_grep, R_read])
       ├─ progress{i=2, phase:"model"}
       ├─ collectStream → toolUses:[Edit]
       ├─ progress{i=2, phase:"tools"}
       ├─ planBatches([Edit]) → [ {concurrent:false, calls:[Edit]} ]
       ├─ runBatches → tool_start(Edit) → await → tool_end(Edit)
       ├─ conv.addToolResultMessage([R_edit])
       ├─ progress{i=3, phase:"model"}
       ├─ collectStream → toolUses:[] , text:"已把超时改为 30 秒"
       ├─ conv.addAssistantMessage("已把超时改为 30 秒")
       └─ done{ reason:"complete", iterations:3, toolsExecuted:3 }
```

### 保序分段示例

```text
模型返回 [Read, Write, Read, Grep]
planBatches →
  batch0 { concurrent:true,  calls:[Read] }        // 只读，独自成并发批
  batch1 { concurrent:false, calls:[Write] }       // 副作用，串行
  batch2 { concurrent:true,  calls:[Read, Grep] }  // 相邻只读，合并并发
执行顺序 batch0 → batch1 → batch2
结果回写顺序 [R_read, R_write, R_read2, R_grep]     // 与模型给出的顺序一致
→ batch1 的写入对 batch2 的读可见（AC24）
```

### Plan Mode 切换链路

```text
用户输入 "/plan"
  handleSubmit 拦截 → setMode("plan") → push system("已切换到计划模式：只读工具可用")
    └─ useEffect([mode]) 重建 client
         ├─ tools = registry.listReadOnly()            // Read / Glob / Grep
         └─ buildSystemPrompt(env, { tools, mode:"plan" })
              └─ usingToolsSection(tools, "plan") 追加"只产出计划，不要修改"

用户下一条消息 "看看认证模块怎么改"
  └─ runLoop({ mode:"plan" })
       └─ registry.definitionsFor(protocol, { readOnlyOnly:true })   // 3 个定义
            → 模型只能读，多次迭代后产出计划文本 → done{ reason:"complete" }

用户输入 "/do" → setMode("execute") → 重建 client → 恢复 6 工具
```

### 停止路径与历史收尾

```text
达到上限（i > 25）:
  历史末尾 = 工具结果消息（user role）
  → conv.addAssistantMessage("（已达到本轮迭代上限 25，任务可能未完成）")   // F4
  → notice("已达到迭代上限（25 轮），本轮中止", isError=true)
  → done{ reason:"max_iterations", iterations:25 }
  → 下一轮 addUserMessage 后，消息序列为 ... assistant / user，角色交替合法

批次执行中取消:
  已完成 [R1 真实结果]，未开始 [C2, C3] → fail("cancelled")
  → conv.addToolResultMessage([R1, R2_cancelled, R3_cancelled])   // 全配对
  → conv.addAssistantMessage("（本轮已被用户中断）")
  → done{ reason:"cancelled" }
```

## 文件组织

```text
typescript/
├── src/
│   ├── agent/
│   │   ├── events.ts          # 新增：AgentEvent / StopReason / LoopPhase
│   │   ├── collect.ts         # 新增：双路流式收集器
│   │   ├── batch.ts           # 新增：planBatches（纯）+ runBatches（生成器）
│   │   ├── loop.ts            # 新增：runLoop（ReAct 循环 + 五种停止条件）
│   │   └── turn.ts            # 删除：受限两段式
│   ├── tools/
│   │   ├── types.ts           # 改：Tool.readOnly；ToolErrorKind 增 cancelled
│   │   ├── limits.ts          # 改：追加三个循环上限
│   │   ├── registry.ts        # 改：definitionsFor 过滤 + listReadOnly
│   │   ├── read.ts            # 改：readOnly: true
│   │   ├── glob.ts            # 改：readOnly: true
│   │   ├── grep.ts            # 改：readOnly: true
│   │   ├── write.ts           # 改：readOnly: false
│   │   ├── edit.ts            # 改：readOnly: false
│   │   └── bash.ts            # 改：readOnly: false
│   ├── prompt/
│   │   ├── sections.ts        # 改：usingToolsSection(tools, mode)
│   │   └── builder.ts         # 改：BuildOptions.mode 透传
│   └── tui/
│       ├── app.tsx            # 改：消费事件流 + mode 状态 + 斜杠命令
│       └── spinner.tsx        # 改：可选 iteration / phase
├── tests/
│   └── agent/
│       ├── collect.test.ts    # 新增：双路一致性 / parseError / 取消
│       ├── batch.test.ts      # 新增：分段划分 / 并发 / 保序 / 批内失败 / 取消
│       ├── loop.test.ts       # 新增：五种停止条件 / 配对 / 事件顺序 / 计划模式
│       └── turn.test.ts       # 删除
└── docs/specs/agent-loop/     # 本章文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 事件流形态 | `AsyncGenerator<AgentEvent>` | 与既有 `client.stream` 形态一致；消费者驱动，天然背压；测试里收成数组即可断言序列（AC13/AC15） |
| 双路收集实现 | `yield*` 取生成器的 `return` 值 | 一次流消费同时得到事件与完整响应，无需回调也无需二次遍历（F15/AC16） |
| 用量事件出处 | `loop.ts` 累加后发出，收集器不 yield usage | spec 要求用量为本轮累计；单次请求用量只存在 `CollectedResponse` 内（F31） |
| 本轮统计传递 | 放在 `done` 事件里，不用函数返回值 | `for await` 拿不到生成器的 return 值；统计必须走事件才能被界面读到 |
| 工具安全性声明 | 单一 `readOnly` 标志，并发性由它派生 | 六个工具的"无副作用"与"可并发"完全重合；两个标志会立刻出现同步维护问题（N7）。计划模式工具集用同一标志过滤 |
| 未知工具的批次归属 | 归为串行批 | 保守：无法确认其副作用；且它本就不会真正执行，只回灌 `unknown_tool` |
| 并发批的事件时序 | 先 yield 全部 start → `Promise.all` → 按原序 yield end | 避免为"谁先完成就先报"引入事件队列；F13 只要求 start 早于 end，N6 要求顺序可复现 |
| 并发上限 | `MAX_CONCURRENT_TOOLS = 8`，超出切子批 | 防模型一次返回几十个读调用耗尽文件句柄；子批仍保序，语义不变 |
| 迭代上限默认值 | 25 | 足够跑完多步任务，又能在模型打转时及时兜住；与 Claude Code 量级一致 |
| 连续无效迭代阈值 | 3 | 1 次误调用可能是模型笔误、值得给重试机会；连续 3 次说明它认定了不存在的工具 |
| 无效迭代判定 | 本次调用**全部**未知才计数，混合不计 | 只要有一个真工具被执行就说明模型仍在推进任务（F8） |
| 上限常量位置 | 追加进 `src/tools/limits.ts` | spec N1 要求与既有工具上限同处；`agent → tools` 是既有依赖方向，不产生环 |
| 停止后的历史收尾 | 非自然停止且末尾为工具结果时补一条助手消息 | `buildAnthropicMessages` 把工具结果映射成 user 消息，不补就会出现连续两条 user，Anthropic 角色交替校验直接 400（F4/AC5） |
| 流错误处理 | 循环内 catch，转 `done{reason:"stream_error"}` | N5 要求不冒泡；界面统一从 `done` 分派，不需要在 `for await` 外再包 try |
| `AbortError` 的位置 | `collectStream` 内转成 `aborted: true` 返回；`runTool` 抛出的由 `loop` catch | 取消不是错误，走正常停止路径；两处来源统一收敛到 `cancelled` |
| 取消检查点 | 迭代开头 / 收集后 / 批次后各查一次 | 覆盖 F7 的三个阶段，且不需要在深层代码里散落 signal 判断 |
| Plan Mode 生效方式 | 模式进 `useEffect` 依赖，切换时重建 client | systemPrompt 在 client 构造时固定；重建 client 只是 new 一个 SDK 对象，代价远小于把 systemPrompt 改成每次请求传参（要改三个 client） |
| 斜杠命令处理位置 | `app.tsx` 的 `handleSubmit` 拦截 | 纯界面状态切换，不该进编排层；也保证命令不写入会话历史（AC29） |
| 计划模式的工具过滤位置 | `registry.definitionsFor(protocol, { readOnlyOnly })` | 工具层只暴露"只读子集"概念，不需要知道 agent 的模式；模式→选项的映射留在 `loop.ts` |
| 多迭代正文的界面处理 | `progress{phase:"tools"}` 与 `done` 时 flush 缓冲成 assistant 消息 | 每次迭代的正文各自成一条消息，不互相覆盖（F28/AC32）；`committedIndexRef` 逻辑不用改 |
| `turn.ts` 的去向 | 删除，连同其测试 | 其核心断言（每轮一个工具、无第三次请求）与本章需求正面冲突，留着就是两份编排逻辑 |
| 三个 LLM client | 完全不改 | 已产出统一 `StreamEvent` 且支持 `tools=[]`；本章的循环只是多调用几次 `stream` |
| 会话层 | 完全不改 | `addAssistantFull` / `addToolResultMessage` 已够用；多迭代只是多调几次 |
