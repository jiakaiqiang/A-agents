# 工具系统与受限单轮闭环 Plan

## 技术栈

沿用第一章既有技术栈，本章不新增任何第三方依赖：

- 运行时：bun（`Bun.Glob` 用于 Glob/Grep 的文件枚举，`node:child_process` 用于命令执行）
- 语言：TypeScript 5.x，`strict` + `verbatimModuleSyntax`，相对导入带 `.js` 扩展
- TUI：Ink 5.x（工具行复用既有 `ChatMessage` 渲染管线）
- LLM SDK：`@anthropic-ai/sdk` ^0.99、`openai` ^6.39（三个 client 已具备流式工具事件解析骨架）
- 文件系统：`node:fs`、`node:path`、`node:os`
- 测试：`bun test`；类型检查 `tsc --noEmit`

不引入 `ripgrep` 二进制、不引入 `zod` / `ajv` / `fast-glob` / `minimatch`：
参数校验用自写的极简校验器（只需覆盖本章 Schema 用到的 object/string/number/boolean/
required/enum），文件枚举用 Bun 内置 `Bun.Glob`（对应 spec N11、AC50）。

## 架构概览（分层）

在既有五层之上新增两层：

1. 入口层 `src/main.tsx` —— 不变。
2. 配置层 `src/config/config.ts` —— 不变。
3. 提示词层 `src/prompt/` —— `usingToolsSection` 改为接收工具清单（F16）。
4. **工具层 `src/tools/`（新增）** —— `Tool` 抽象、六个工具实现、注册中心、
   参数校验、路径边界、脱敏、资源上限、统一执行入口。不依赖 LLM 层与 TUI 层。
5. LLM 协议层 `src/llm/` —— 三个 client 补 `parseError`（F14）；消息构造已支持
   `toolUses` / `toolResults`（F15），无需改动。
6. 会话层 `src/conversation/conversation.ts` —— 已具备 `addAssistantFull` /
   `addToolResultMessage`，无需改动。
7. **编排层 `src/agent/turn.ts`（新增）** —— 受限单轮闭环（F17–F21）。与 Ink 解耦，
   通过回调把事件推给 TUI，可用假 client 单测。
8. TUI 层 `src/tui/` —— `app.tsx` 改为调用 `runTurn`；`chat.tsx` 增加工具行渲染。

依赖方向严格单向：`tools` ← `agent` ← `tui`，`tools` 不反向依赖任何上层。

## 数据流（一轮对话）

```text
[用户提交]
  <InputBox onSubmit> → handleSubmit(text)
    ├─ setMessages([...prev, user])
    ├─ conv.addUserMessage(text)
    ├─ setIsStreaming(true) + new AbortController()
    └─ runTurn({ client, conv, registry, protocol, workDir, signal, callbacks })

[第一次模型请求 —— 携带工具定义]
  client.stream(conv, registry.definitionsFor(protocol), signal)
    text_delta            → callbacks.onText(delta)      → setStreamingText
    thinking_delta        → callbacks.onThinking(delta)   → （不渲染）
    thinking_complete     → 收集 ThinkingBlock[]
    tool_call_complete    → 收集 ToolUseBlock[]（含 parseError）
    stream_end            → 累计 usage

[分支 A：无工具调用]
  conv.addAssistantMessage(text) → 本轮结束（仅 1 次请求，行为与第一章一致）

[分支 B：有工具调用]
  conv.addAssistantFull(text, thinkingBlocks, toolUses)
  ├─ toolUses[0]:
  │    callbacks.onToolStart(id, name, tool.callSummary(args))   → 工具行立即出现
  │    result = await runTool(registry, name, args, ctx)          → 校验→执行→脱敏→截断
  │    callbacks.onToolEnd(id, result)                            → 工具行补摘要
  ├─ toolUses[1..]: 各生成 unsupported 失败结果 + callbacks.onNotice(...)
  └─ conv.addToolResultMessage(results)   // 按原顺序，调用 ID 一一配对

[第二次模型请求 —— 不携带工具定义]
  client.stream(conv, [], signal)
    text_delta          → callbacks.onText(delta)
    tool_call_complete  → 不执行；callbacks.onNotice("最终续答阶段不支持工具调用", true)
                          且该 tool_use 块不写入历史
    stream_end          → 累计 usage → callbacks.onUsage(累计值)
  conv.addAssistantMessage(finalText) → 本轮结束（无第三次请求）

[中断 / 错误]
  AbortError → 已完成的 tool_use / tool_result 保持配对；部分文本保留；会话可继续
  LLMError   → setError 红字；会话可继续
```

## 核心数据结构与接口

```ts
// ───────── src/tools/types.ts ─────────
export interface JSONSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: string };
  default?: unknown;
}
export interface JSONSchemaObject {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required: string[];
  additionalProperties?: false;
}

export type ToolErrorKind =
  | "invalid_params"   // 参数缺失 / 类型错误 / 正则非法
  | "out_of_scope"     // 越出工作目录
  | "not_found"        // 文件不存在 / 原文未匹配
  | "match_count"      // 匹配数不符（Edit 多处命中）
  | "timeout"          // 命令超时
  | "exec_failed"      // 无法启动进程 / 读写失败
  | "unknown_tool"     // 注册中心查无此工具
  | "unsupported";     // 本期不支持（第二个及之后的工具调用）

export interface ToolResult {
  ok: boolean;
  content: string;                    // 回灌模型的完整文本
  summary: string;                    // 工具行一行摘要
  detail?: Record<string, unknown>;   // matches / exitCode / truncated / lines ...
  errorKind?: ToolErrorKind;
}

export interface ToolContext {
  workDir: string;          // 启动目录，工具唯一根
  signal?: AbortSignal;     // 中断
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchemaObject;
  callSummary(args: Record<string, unknown>): string;   // "Read(src/x.ts)"
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// 构造统一结果的辅助
export function ok(content: string, summary: string, detail?: Record<string, unknown>): ToolResult;
export function fail(kind: ToolErrorKind, message: string, detail?: Record<string, unknown>): ToolResult;

// ───────── src/tools/registry.ts ─────────
export class ToolRegistry {
  register(tool: Tool): this;
  get(name: string): Tool | undefined;
  list(): Tool[];
  definitionsFor(protocol: ProviderProtocol): Record<string, unknown>[];
}
export function createDefaultRegistry(): ToolRegistry;   // src/tools/index.ts

// ───────── src/tools/execute.ts ─────────
export async function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult>;   // 查找 → 校验 → try/catch 执行 → 脱敏 → 截断

// ───────── src/tools/paths.ts ─────────
export type ResolvedPath =
  | { ok: true; absolute: string; display: string }   // display 为 POSIX 相对路径
  | { ok: false; reason: string };
export function resolveInside(workDir: string, input: string): ResolvedPath;
export function toPosix(relativePath: string): string;

// ───────── src/tools/redact.ts ─────────
export function redact(text: string): string;

// ───────── src/tools/schema.ts ─────────
export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };
export function validate(schema: JSONSchemaObject, args: unknown): ValidationResult;

// ───────── src/llm/events.ts（改动） ─────────
| { type: "tool_call_complete"; toolId: string; toolName: string;
    arguments: Record<string, unknown>; parseError?: string }   // 新增 parseError

// ───────── src/agent/turn.ts ─────────
export interface TurnCallbacks {
  onText(delta: string): void;
  onThinking(delta: string): void;
  onToolStart(id: string, name: string, argSummary: string): void;
  onToolEnd(id: string, result: ToolResult): void;
  onNotice(text: string, isError: boolean): void;
  onUsage(usage: UsageInfo): void;          // 两次请求的累计值
  onPhase(phase: "first" | "tool" | "final"): void;
}
export interface TurnOptions {
  client: LLMClient;
  conversation: ConversationManager;
  registry: ToolRegistry;
  protocol: ProviderProtocol;
  workDir: string;
  signal?: AbortSignal;
  callbacks: TurnCallbacks;
}
export interface TurnOutcome {
  requestCount: number;      // 1 或 2，供测试断言
  toolsExecuted: number;     // 0 或 1
  finalText: string;
  aborted: boolean;
}
export async function runTurn(options: TurnOptions): Promise<TurnOutcome>;

// ───────── src/tui/chat.tsx（改动） ─────────
export interface ChatMessage {
  role: ChatRole;            // 已含 "tool_use" / "tool_result"
  content: string;
  isError?: boolean;
  toolId?: string;           // 新增：用于执行结束后原地更新同一条工具行
}
```

## 模块设计

### 模块 `src/tools/limits.ts`

- 职责：集中声明全部资源上限（spec N3），单点可调。
- 内容：

  | 常量 | 值 | 用途 |
  |------|-----|------|
  | `BASH_TIMEOUT_MS` | 120_000 | 命令默认超时 |
  | `BASH_MAX_TIMEOUT_MS` | 600_000 | 模型可指定的超时上限 |
  | `BASH_MAX_OUTPUT_CHARS` | 30_000 | stdout/stderr 各自截断阈值 |
  | `READ_MAX_LINES` | 2_000 | 单次读文件行数 |
  | `READ_MAX_LINE_CHARS` | 2_000 | 单行超长截断 |
  | `GLOB_MAX_RESULTS` | 100 | Glob 结果条数 |
  | `GREP_MAX_MATCHES` | 100 | Grep 命中条数 |
  | `GREP_MAX_FILE_BYTES` | 1_000_000 | 跳过超大文件 |
  | `TOOL_RESULT_MAX_CHARS` | 30_000 | 工具结果写入历史前的总上限 |
  | `SUMMARY_MAX_CHARS` | 72 | 工具行摘要长度 |
  | `IGNORED_DIRS` | `.git` `node_modules` `dist` `build` `.next` `target` `coverage` `.venv` `__pycache__` `.cache` | Glob/Grep 忽略目录 |

- 依赖：无。

### 模块 `src/tools/paths.ts`

- 职责：把模型给的任意路径解析为工作目录内的绝对路径，或拒绝（F11）。
- 关键行为 `resolveInside(workDir, input)`：
  1. `input` 为空或非字符串 → `{ ok: false }`。
  2. `absolute = resolve(workDir, input)`（同时覆盖相对路径与绝对路径两种输入）。
  3. `realWorkDir = realpathSync(workDir)`。
  4. 从 `absolute` 逐级向上找到**最近的已存在祖先**，对其 `realpathSync`，再把剩余
     路径段拼回 —— 这样既能穿透符号链接判定真实位置，又能处理"目标文件尚不存在"的
     写入场景（`Write` 需要）。
  5. `rel = relative(realWorkDir, realAbsolute)`；若 `rel` 为空字符串（即等于根）、
     以 `..` 开头，或 `isAbsolute(rel)` → 拒绝，`reason` 说明"路径超出工作目录"。
  6. 通过则返回 `{ ok: true, absolute: realAbsolute, display: toPosix(rel) }`。
- `toPosix(p)`：`p.split(sep).join("/")`，保证对模型呈现的路径为 POSIX 风格（N6）。
- 依赖：`node:fs`、`node:path`。

### 模块 `src/tools/redact.ts`

- 职责：唯一的脱敏出口（spec N5），供 `execute.ts` 在结果出口统一调用。
- 模式集合（按顺序替换为 `[redacted]`，保留键名）：
  - `sk-[A-Za-z0-9_\-]{16,}`（OpenAI / 兼容端点风格）
  - `ghp_` / `gho_` / `ghu_` / `ghs_` / `github_pat_` 前缀令牌
  - `AKIA[0-9A-Z]{16}`（AWS Access Key ID）
  - `xox[baprs]-[A-Za-z0-9-]{10,}`（Slack）
  - `-----BEGIN [A-Z ]*PRIVATE KEY-----` 到 `-----END ...-----` 整块
  - `Bearer\s+[A-Za-z0-9._\-]{16,}`
  - `(api[_-]?key|apikey|token|secret|password|passwd|credential)\s*[:=]\s*["']?<value>`
    —— 只替换 value，保留键名
  - JWT：`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
- 依赖：无。

### 模块 `src/tools/schema.ts`

- 职责：按 `JSONSchemaObject` 校验模型给的参数（F12），不引入校验库。
- 关键行为：
  - `required` 缺失 → `"missing required parameter: <name>"`。
  - 类型不符 → `"parameter <name> must be <type>"`；`integer` 额外查
    `Number.isInteger`；`enum` 不匹配 → 列出允许值。
  - 未声明的多余字段忽略（宽松），但不透传给工具。
  - 返回**只含已声明字段**的新对象，工具内部可安全按类型断言取值。
- 依赖：`types.ts`。

### 模块 `src/tools/read.ts`（工具 `Read`）

- Schema：`file_path`(string, required)、`offset`(integer)、`limit`(integer)。
- 行为：`resolveInside` → `statSync` 判目录 → 读文件 → 含 ` ` 判为二进制 →
  按 `\n` 切行 → 应用 `offset`（1 基）与 `limit`（默认 `READ_MAX_LINES`）→ 单行超
  `READ_MAX_LINE_CHARS` 截断 → 输出 `<行号>\t<内容>`，行号为文件真实行号。
- 结果：`content` 末尾附 `[truncated: showing lines A-B of N]`（若截断）；
  `summary` 形如 `42 lines`；空文件返回明确说明。
- 失败：`not_found`（不存在）、`invalid_params`（是目录 / 二进制 / offset 越界）、
  `out_of_scope`、`exec_failed`（读失败）。

### 模块 `src/tools/write.ts`（工具 `Write`）

- Schema：`file_path`(string, required)、`content`(string, required)。
- 行为：`resolveInside` → `mkdirSync(dirname, { recursive: true })` →
  `writeFileSync(absolute, content, "utf8")`。写入前记录目标是否已存在，用于摘要
  区分 `created` / `updated`。
- 结果：`summary` 形如 `updated, 37 lines`；`content` 说明路径与写入规模。
- 失败：`out_of_scope`、`exec_failed`（目录创建或写入失败，错误文本含系统 errno）。

### 模块 `src/tools/edit.ts`（工具 `Edit`）

- Schema：`file_path`(string, required)、`old_string`(string, required)、
  `new_string`(string, required)、`replace_all`(boolean)。
- 行为：
  1. `resolveInside` → 文件不存在 → `not_found`。
  2. `old_string === new_string` → `invalid_params`。
  3. `count = original.split(old_string).length - 1`。
  4. `count === 0` → `not_found`，提示"未找到原文片段，请先用 Read 确认内容"。
  5. `count > 1 && !replace_all` → `match_count`，错误文本含
     `found N occurrences, expected exactly 1`，`detail.matches = N`，**不写文件**。
  6. 替换：`replace_all` 用 `split/join` 全量替换；否则只替换第一处
     （用 `indexOf` + 切片，避免 `String.replace` 对 `$&` 等特殊串的解释）。
  7. 保留原文件换行风格：若原文含 `\r\n` 且 `new_string` 只含 `\n`，按原风格归一。
- 结果：`summary` 形如 `replaced 1 occurrence` / `replaced 3 occurrences`。

### 模块 `src/tools/bash.ts`（工具 `Bash`）

- Schema：`command`(string, required)、`timeout`(integer, ms)、`description`(string)。
- 行为：
  - shell 选择（N6）：win32 → `process.env.ComSpec ?? "cmd.exe"` + `["/d","/s","/c",cmd]`；
    其余 → `/bin/sh -c cmd`。
  - `spawn(shell, args, { cwd: ctx.workDir, windowsVerbatim: true })`；`cwd` 恒为
    工作目录，命令内 `cd` 不影响后续调用（AC29）。
  - 累积 stdout / stderr，各自超 `BASH_MAX_OUTPUT_CHARS` 停止累积并标记截断。
  - 超时：`setTimeout` 到期 `kill`（win32 用 `taskkill /T /F` 兜掉子进程树），
    结果 `errorKind = "timeout"`，`ok = false`。
  - `ctx.signal` abort → 同样 kill，抛 `AbortError` 由编排层处理。
  - `spawn` 的 `error` 事件（ENOENT 等）→ `exec_failed`。
  - **非零退出不判错**（F8）：`ok = true`，`detail.exitCode = code`，输出完整保留。
- 结果：`content` 为 `exit code / stdout / stderr` 三段结构化文本；
  `summary` 形如 `exit 0` / `exit 1` / `timed out after 120s`。

### 模块 `src/tools/glob.ts`（工具 `Glob`）

- Schema：`pattern`(string, required)、`path`(string)。
- 行为：`path` 经 `resolveInside`（默认 `workDir`）→ `new Bun.Glob(pattern).scan({
  cwd, onlyFiles: true, followSymlinks: false })` → 过滤路径段命中 `IGNORED_DIRS` 的
  条目 → `statSync().mtimeMs` 倒序 → 截断至 `GLOB_MAX_RESULTS`。
- 结果：`content` 为 POSIX 相对路径逐行列表 + 截断标注；无匹配返回 `ok: true` 且
  `summary = "no files matched"`（AC24）。
- 失败：`out_of_scope`；`Bun.Glob` 构造/扫描异常 → `invalid_params` / `exec_failed`。

### 模块 `src/tools/grep.ts`（工具 `Grep`）

- Schema：`pattern`(string, required)、`path`(string)、`glob`(string)、
  `-i`(boolean)、`output_mode`(enum: `content` | `files_with_matches` | `count`)。
- 行为：
  1. `new RegExp(pattern, flags)` —— 构造失败 → `invalid_params`（AC27）。
  2. 文件集：`Bun.Glob(glob ?? "**/*").scan({ cwd: 解析后的 path })`，过滤
     `IGNORED_DIRS`。
  3. 逐文件：`statSync().size > GREP_MAX_FILE_BYTES` 跳过；读文本，含 ` ` 跳过。
  4. 逐行匹配，命中记 `{ path, line, text }`；`text` 超长截断；累计到
     `GREP_MAX_MATCHES` 立即停止并标记截断。
  5. `output_mode` 决定输出形态：`content` → `path:line:text`；
     `files_with_matches` → 去重路径列表；`count` → `path:count`。
- 结果：`summary` 形如 `4 matches in 2 files` / `no matches`。

### 模块 `src/tools/registry.ts`

- 职责：登记、按名查找、三协议定义导出（F3、F4）。
- `definitionsFor(protocol)` 由同一份 `tool.parameters` 派生：

  ```ts
  anthropic      → { name, description, input_schema: parameters }
  openai         → { type: "function", name, description, parameters }
  openai-compat  → { type: "function", function: { name, description, parameters } }
  ```

- 纯函数、无 IO，可在无网络单测中断言三份定义的 name/description/required 一致（AC3）。

### 模块 `src/tools/execute.ts`

- 职责：工具调用的唯一执行入口，把"查找 → 校验 → 执行 → 脱敏 → 截断"串成一条链，
  确保 F2 / F12 / F13 / N1 / N5 对**所有**工具一致生效。
- 关键行为：
  1. `registry.get(name)` 为空 → `fail("unknown_tool", ...)`。
  2. `validate(tool.parameters, args)` 失败 → `fail("invalid_params", errors.join("; "))`。
  3. `try { await tool.execute(validated, ctx) } catch (e) { … }`：`AbortError` 原样
     抛出交编排层处理；其余异常 → `fail("exec_failed", message)`（N1）。
  4. 对 `content` 与 `summary` 施加 `redact()`（N5）。
  5. 对 `content` 施加 `TOOL_RESULT_MAX_CHARS` 截断，追加
     `[truncated: kept N of M chars]`（F13）。
  6. `summary` 施加 `SUMMARY_MAX_CHARS` 单行化截断（F23）。

### 模块 `src/tools/index.ts`

- `createDefaultRegistry()`：登记 Read / Write / Edit / Bash / Glob / Grep 六个工具，
  返回 `ToolRegistry`。这是唯一的工具清单来源（N7）。

### 模块 `src/agent/turn.ts`

- 职责：受限单轮闭环（F17–F21），不含任何 Ink / React 依赖。
- 内部辅助 `collectStream(client, conv, tools, signal, callbacks, usageAcc)`：
  消费一次 `client.stream`，返回
  `{ text, thinkingBlocks, toolUses, parseErrors, stopReason }`。
- 主流程见"数据流"一节。三处关键正确性点：
  1. **调用与结果严格配对**（F15）：`toolResults` 按 `toolUses` 原顺序生成，
     未执行的调用也各有一条 `unsupported` 结果。
  2. **parseError 短路**（F14）：某调用带 `parseError` 时不执行，直接产出
     `invalid_params` 结果。
  3. **续答阶段的 tool_use 不入历史**（F19 / AC40）：Anthropic 要求 assistant 消息里
     每个 `tool_use` 都被下一条 user 消息的 `tool_result` 配对；本期没有第三次请求，
     若持久化就会让**下一轮**请求直接报 400。因此只写文本，丢弃这些块。
- 依赖：`llm/client.ts`（仅接口）、`conversation`、`tools`。

### 模块 `src/prompt/sections.ts`（改动）

- `usingToolsSection(tools: Array<{ name: string; description: string }>)`：
  - 工具清单由 `registry.list()` 派生（N7），不手写第二份。
  - 追加本期约束文本（F16）：每轮最多执行一个工具；路径使用相对于工作目录的相对路径；
    工具操作不得越出工作目录；修改文件前先用 Read 确认内容。
  - 工具列表为空时回退为原来的"本次会话尚未配置工具调用能力"文案（N13）。
- `builder.ts`：`BuildOptions` 增加 `tools?: Array<{name, description}>` 并透传。

### 模块 `src/tui/app.tsx`（改动）

- `registryRef = useRef(createDefaultRegistry())`。
- `buildSystemPrompt(env, { tools: registryRef.current.list().map(pick(name, description)) })`。
- `runAgentLoop` 改为组装 `TurnCallbacks` 后调用 `runTurn`：
  - `onToolStart` → `setMessages(prev => [...prev, { role: "tool_use", toolId, content: "● " + summary }])`
  - `onToolEnd` → `setMessages(prev => prev.map(m => m.toolId === id ? { ...m, content: m.content + " — " + result.summary, isError: !result.ok } : m))`
    —— 因 `committedIndexRef` 只在轮末前移，这条消息此时仍在 `active` 区，
    原地更新即可，不需改 `<Static>` 逻辑。
  - `onNotice` → push 一条 `system` 角色消息（`isError` 决定颜色）。
  - `onUsage` → `setInputTokens` / `setOutputTokens`（两次请求累计，F21）。
- 轮末统一 `committedIndexRef.current = messages.length`，把用户消息、工具行、
  助手答复一并交给 `<Static>`。

### 模块 `src/tui/chat.tsx`（改动）

- `ChatMessage` 增加可选 `toolId`。
- `MessageBlock` 对 `tool_use` / `tool_result` 分支：`isError` 时用 `brand.error`，
  否则 `brand.tool`（`styles.ts` 已有 `tool: "#38bdf8"`），不走 markdown 渲染
  （避免工具输出被当正文美化，F23）。

## 模块交互

### 启动调用链（新增部分）

```text
main.tsx → render(<App/>)
  └─ App 初始化
       ├─ registryRef = createDefaultRegistry()        // src/tools/index.ts
       ├─ buildSystemPrompt(env, { tools: registry.list() })   // F16
       └─ createClient(provider, systemPrompt)
```

### 一轮工具调用时序

```text
handleSubmit(text)
  └─ runTurn(...)                                   // src/agent/turn.ts
       ├─ [phase=first] client.stream(conv, registry.definitionsFor(protocol), signal)
       │     tool_call_complete(id=t1, name="Read", args={file_path:"src/x.ts"})
       ├─ conv.addAssistantFull(text, thinking, [t1])
       ├─ callbacks.onToolStart(t1, "Read", "Read(src/x.ts)")
       │     → setMessages(+{role:"tool_use", toolId:t1, content:"● Read(src/x.ts)"})
       ├─ [phase=tool] runTool(registry, "Read", args, {workDir, signal})
       │     ├─ registry.get("Read")
       │     ├─ validate(schema, args)
       │     ├─ tool.execute → resolveInside → readFileSync → 带行号文本
       │     ├─ redact(content/summary)
       │     └─ 截断至 TOOL_RESULT_MAX_CHARS
       ├─ callbacks.onToolEnd(t1, result)
       │     → 原地更新为 "● Read(src/x.ts) — 42 lines"
       ├─ conv.addToolResultMessage([{ toolUseId:t1, content, isError:!ok }])
       ├─ [phase=final] client.stream(conv, [], signal)      // 不带工具定义
       │     text_delta → onText → setStreamingText
       ├─ conv.addAssistantMessage(finalText)
       └─ callbacks.onUsage(usage1 + usage2)
```

### 多工具调用与续答越界的处理

```text
首次响应含 [t1, t2, t3]:
  执行 t1 → 结果 R1
  t2, t3 → fail("unsupported", "本期每轮仅支持一个工具调用；该调用未执行")
  conv.addToolResultMessage([R1, R2_unsupported, R3_unsupported])   // 顺序与 ID 全配对
  onNotice("已跳过 2 个工具调用（本期每轮仅执行一个）", isError=false)

续答阶段又出现 tool_call_complete:
  不执行、不写入 tool_use 块
  onNotice("最终续答阶段不支持工具调用", isError=true)
  仅把已收到的文本作为 assistant 消息写入历史 → 结束本轮
```

### 数据流图

```text
createDefaultRegistry() ──list()──> [{name, description}] ──> usingToolsSection ──> systemPrompt
                        ──definitionsFor(protocol)──> tools[] ──> client.stream(第一次)

client.stream ──StreamEvent──> turn.ts 收集 toolUses[]
toolUses[0] ──runTool──> ToolResult ──redact+truncate──> conv.addToolResultMessage
                                    └──summary──> callbacks.onToolEnd ──> 工具行

conv(含 tool_use + tool_result) ──buildAnthropicMessages / buildOpenAIInput
                                  / buildChatCompletionMessages──> client.stream(第二次, tools=[])
                                  └──text_delta──> streamingText ──> 最终答复
```

## 文件组织

```text
typescript/
├── src/
│   ├── tools/                      # 新增：工具层
│   │   ├── types.ts                # Tool / ToolResult / ToolContext / JSONSchema / ok+fail
│   │   ├── limits.ts               # 全部资源上限与忽略目录
│   │   ├── paths.ts                # resolveInside / toPosix（工作目录边界）
│   │   ├── redact.ts               # 密钥脱敏唯一出口
│   │   ├── schema.ts               # 极简参数校验器
│   │   ├── read.ts                 # 工具 Read
│   │   ├── write.ts                # 工具 Write
│   │   ├── edit.ts                 # 工具 Edit
│   │   ├── bash.ts                 # 工具 Bash
│   │   ├── glob.ts                 # 工具 Glob
│   │   ├── grep.ts                 # 工具 Grep
│   │   ├── registry.ts             # ToolRegistry + definitionsFor
│   │   ├── execute.ts              # runTool：查找→校验→执行→脱敏→截断
│   │   └── index.ts                # createDefaultRegistry
│   ├── agent/                      # 新增：编排层
│   │   └── turn.ts                 # runTurn：受限单轮闭环
│   ├── llm/
│   │   ├── events.ts               # 改：tool_call_complete 增 parseError
│   │   ├── anthropic.ts            # 改：JSON 解析失败带 parseError
│   │   └── openai.ts               # 改：两个 client 各一处同上
│   ├── prompt/
│   │   ├── sections.ts             # 改：usingToolsSection(tools)
│   │   └── builder.ts              # 改：BuildOptions.tools 透传
│   └── tui/
│       ├── app.tsx                 # 改：registry + runTurn + 工具行状态
│       └── chat.tsx                # 改：ChatMessage.toolId + 工具行渲染
├── tests/
│   ├── tools/
│   │   ├── paths.test.ts           # 越界拒绝（绝对路径 / .. / 符号链接）
│   │   ├── redact.test.ts          # 各类密钥脱敏、键名保留
│   │   ├── schema.test.ts          # 必填缺失 / 类型不符 / enum
│   │   ├── read.test.ts            # 行号 / offset+limit / 目录 / 二进制 / 截断
│   │   ├── write.test.ts           # 创建 / 覆盖 / 自动建父目录 / 越界
│   │   ├── edit.test.ts            # 匹配 0 / 1 / N 次 + replace_all
│   │   ├── bash.test.ts            # exit 0 / 非零 / 超时 / 启动失败 / 输出截断
│   │   ├── glob.test.ts            # 忽略目录 / mtime 倒序 / 上限截断 / 无匹配
│   │   ├── grep.test.ts            # 命中格式 / glob 过滤 / 非法正则 / 上限
│   │   ├── registry.test.ts        # 三协议定义一致 + unknown_tool
│   │   └── execute.test.ts         # 校验拦截 / 异常兜底 / 脱敏 / 截断
│   └── agent/
│       └── turn.test.ts            # 无工具 / 一个工具 / 多工具 / 续答越界 / 中断
└── docs/specs/tool-use/            # 本章文档
    ├── spec.md
    ├── plan.md
    ├── task.md
    └── checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 工具抽象形态 | 单一 `Tool` 接口，元信息与 `execute` 同处声明 | 避免 Schema 与实现漂移；新增工具只碰一个文件（N7） |
| 参数校验 | 自写极简校验器（~60 行） | 本章 Schema 只用到 object/string/number/boolean/enum；引入 zod/ajv 属过度依赖（AC50） |
| 校验位置 | 统一在 `runTool` 中，不在各工具内 | F12 对全部工具一致生效；工具体内可直接类型断言取值 |
| 结果结构 | `{ ok, content, summary, detail, errorKind }` | `content` 给模型、`summary` 给工具行、`errorKind` 给测试与定位（N12） |
| 错误策略 | 一律返回失败结果，不抛异常；`runTool` 兜 try/catch | N1 要求会话不中断；`AbortError` 是唯一例外，需上抛给编排层 |
| 路径边界实现 | 最近已存在祖先 `realpathSync` + `relative` 判 `..` | 同时挡住绝对路径、`..`、符号链接；且对"待创建文件"可用（Write 需要） |
| 路径呈现 | 对模型统一 POSIX 相对路径 | 跨平台一致（N6）；相对路径也更省 token |
| 脱敏位置 | 唯一出口在 `runTool`，作用于 content + summary | spec N5 明确要求"不允许各工具各写一套" |
| 命令非零退出 | 判为 `ok: true`，仅记 `exitCode` | F8：`grep` 无匹配、`diff` 有差异都用非零退出表达语义，判错会误导模型 |
| 命令 shell | win32 用 `ComSpec`，其余 `/bin/sh -c` | N6 要求各平台用默认 shell；当前开发环境为 Windows 11 |
| 命令超时终止 | `kill` + win32 `taskkill /T /F` | Windows 上 `kill` 不杀子进程树，长命令会残留 |
| Glob/Grep 实现 | Bun 内置 `Bun.Glob` + `RegExp` 逐行匹配 | 零额外安装、零外部二进制；`ripgrep` 需用户预装（AC50） |
| Glob 排序 | `mtimeMs` 倒序 | spec F9 明确要求；最近改动的文件对 Agent 更相关 |
| 忽略目录 | 固定清单 `IGNORED_DIRS`，不读 `.gitignore` | 本章不引入 gitignore 解析；固定清单已覆盖 spec 列举的三类 |
| 结果截断 | 单条 30_000 字符上限 + 显式截断标注 | F13/N9：防单次输出挤占上下文；标注让模型知道内容不完整 |
| 编排层位置 | 独立 `src/agent/turn.ts`，与 Ink 解耦 | 用假 client 即可单测请求次数与历史配对（N10、AC38–AC40） |
| 每轮请求上限 | 硬编码两次，无循环结构 | spec 明确本期不做 Agent Loop；用显式两段代码而非 `for` + `maxIter`，避免留下"改个常量就变循环"的歧义 |
| 多工具调用 | 执行第一个，其余回灌 `unsupported` | F18：Anthropic 要求每个 `tool_use` 必须有配对 `tool_result`，静默丢弃会导致下一轮 400 |
| 续答阶段的 tool_use | 不执行且不写入历史 | F19/AC40：本期没有第三次请求，写入就会让下一轮请求缺配对而失败 |
| 工具行更新方式 | 同一条 `ChatMessage` 按 `toolId` 原地改写 | `committedIndexRef` 轮末才前移，工具行此时仍在 active 区，无需改 `<Static>` |
| 工具行渲染 | 不走 `marked` | F23：工具输出不应被 markdown 美化，且完整输出不进聊天区 |
| 提示词工具清单 | 由 `registry.list()` 派生 | N7：不存在需要同步维护的第二份列表 |
| 缓存标记 | 不动 `markLastUserTailForCache` 与 system 的 `cache_control` | N9：工具消息加入不得改变既有缓存策略 |
| thinking 与工具共存 | 依赖既有 `buildAnthropicMessages` 把 `thinkingBlocks` 排在 `tool_use` 之前 | Anthropic 要求 thinking 块在同一 assistant 消息中先于 tool_use 重放，现有实现已满足 |
| 测试临时目录 | `mkdtempSync(join(tmpdir(), "mewcode-"))` + `afterEach` 清理 | N10/AC48：不污染仓库工作区 |
