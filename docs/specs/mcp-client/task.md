# MCP 客户端 Tasks

> 验证命令统一在 `typescript/` 目录下执行：`bun run typecheck`、`bun test`。
> 权限模块唯一改动点是 `src/permission/rules.ts` 的 `subjectFor`/`ruleTextFor`（plan D5），其余权限文件不动。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/types.ts` | MCP 配置、工具定义、调用结果、连接报告类型 |
| 新建 | `src/mcp/jsonrpc.ts` | JSON-RPC 2.0 连接：id 配对、通知丢弃 |
| 新建 | `src/mcp/transport-stdio.ts` | 子进程 stdio 管道传输 |
| 新建 | `src/mcp/transport-http.ts` | Streamable HTTP 传输（JSON/SSE 响应） |
| 新建 | `src/mcp/client.ts` | 单 Server 会话：三步握手、列工具、调工具 |
| 新建 | `src/mcp/adapter.ts` | 远端工具 → MewCode Tool 包装 |
| 新建 | `src/mcp/manager.ts` | 并行连接、注册、报告、退出清理 |
| 修改 | `src/config/config.ts` | mcp_servers map 解析、${VAR} 展开、键级合并 |
| 修改 | `src/permission/rules.ts` | MCP 工具的规则主题与规则文本（plan D5） |
| 修改 | `src/main.tsx` | 启动时 connectAll、报告传入 App |
| 修改 | `src/tui/app.tsx` | 接收报告 prop、系统消息呈现 |
| 新建 | `tests/mcp/jsonrpc.test.ts` | 协议层用例 |
| 新建 | `tests/mcp/transport-stdio.test.ts` | stdio 传输用例 |
| 新建 | `tests/mcp/transport-http.test.ts` | http 传输用例 |
| 新建 | `tests/mcp/client.test.ts` | 握手与调用用例 |
| 新建 | `tests/mcp/adapter.test.ts` | 适配层用例 |
| 新建 | `tests/mcp/manager.test.ts` | 管理器集成用例 |
| 修改 | `tests/config.test.ts` | mcp_servers map 解析用例 |
| 修改 | `tests/permission/rules.test.ts` | MCP 规则主题用例 |

## T1: MCP 类型定义

**文件：** `src/mcp/types.ts`
**依赖：** 无
**步骤：**
1. 定义 `McpServerConfig`：`type: "stdio" | "http"`、`enabled: boolean`、`timeout?: number`、`command?: string`、`args?: string[]`、`env?: Record<string, string>`、`url?: string`、`headers?: Record<string, string>`。
2. 定义 `McpInitializeResult`：`protocolVersion: string`、`serverInfo: { name: string; version: string }`、`capabilities: Record<string, unknown>`。
3. 定义 `McpToolDef`：`name: string`、`description?: string`、`inputSchema: Record<string, unknown>`。
4. 定义 `McpContentBlock`（`type: string; text?: string`）与 `McpCallToolResult`（`content: McpContentBlock[]; isError?: boolean`）。
5. 定义 `McpServerReport` 判别联合：`ok`（带 `toolCount`、`tools`）、`disabled`、`failed`（带 `reason`）、`timeout`（带 `timeoutMs`）四态。
6. 定义 `McpTransport` 接口：`send(text): Promise<void>`、`onMessage(cb)`、`onClose(cb)`、`close(): Promise<void>`。

**验证：** `bun run typecheck` 通过。

## T2: 配置解析改造（map + ${VAR} 展开）

**文件：** `src/config/config.ts`
**依赖：** T1
**步骤：**
1. `AppConfig.mcp_servers` 类型改为 `Record<string, McpServerConfig>`（从 `typescript/src/mcp/types.js` import 类型——config.ts 现在不依赖 mcp 模块，此处是唯一例外，只 import type 不产生运行时依赖）。
2. `loadSingleFile`：`raw.mcp_servers` 按对象（map）读取；值为非对象或缺少必填字段（stdio 缺 `command`、http 缺 `url`）时不抛异常，跳过并记录到返回值。`loadSingleFile` 签名扩展为返回 `{ config, warnings }` 或在 AppConfig 上挂 `mcp_warnings`（选实现简单者，保持对外既有字段不变）。
3. 新增导出 `expandEnvVars(value: string, lookup: (name: string) => string | undefined): { value: string; warnings: string[] }`：`${VAR}` 占位符替换；lookup 回调由调用方注入（Manager 构造：先查 Server env 自身、再查 `process.env`）；未定义 → 空串 + 警告。
4. 新增内部函数 `resolveMcpServer(name, rawServer): { config?: McpServerConfig; warnings: string[] }`：校验 type 合法性（非 `stdio`/`http` 视为 `stdio`）、必填字段、调 `expandEnvVars` 展开 env 与 headers 的每个值（lookup 顺序：同 Server env 前置键 → `process.env`）。
5. `mergeConfig`：`mcp_servers` 从「按 name 数组合并」改为「键级覆盖合并」——项目级同名键整体替换用户级。
6. `validateProviders` 不动；确认 `loadConfig` 三文件级联路径上 map 合并正确。

**验证：** `bun run typecheck` 通过；`bun test tests/config.test.ts` 全绿（T13 补用例后）。

## T3: JsonRpcConnection

**文件：** `src/mcp/jsonrpc.ts`
**依赖：** T1
**步骤：**
1. `class JsonRpcConnection`，构造时接收 `McpTransport`。
2. `send(method, params?): Promise<unknown>`：自增 id 组 `JsonRpcRequest`，`JSON.stringify` 后 `transport.send`；pending 表记 `id → { resolve, reject }`。
3. `notify(method, params?): Promise<void>`：发无 id 消息，不进 pending 表。
4. `handleMessage(text)`：`JSON.parse` 失败 → 静默丢弃；有 `id` → 从 pending 表取出并兑付（`error` 存在则 reject，否则 resolve `result`）；无 `id` → 丢弃。
5. 注册 `transport.onMessage(handleMessage)`；`transport.onClose(reason)` 时 reject 全部 pending（错误消息含 reason）并标记关闭。
6. 关闭后 `send` 直接 reject「连接已关闭」。

**验证：** `bun run typecheck` 通过。

## T4: StdioTransport

**文件：** `src/mcp/transport-stdio.ts`
**依赖：** T1
**步骤：**
1. `class StdioTransport implements McpTransport`，构造参数 `(command, args, env, cwd)`；`spawn` 时 `windowsHide: true`、合并 `process.env` 与配置 env。
2. stdout 按行分割（积累缓冲、遇 `\n` 切出完整行），空行跳过，每行喂 `onMessage` 回调。
3. stderr 持续收集，截断保留末尾 500 字符，供失败文案。
4. 子进程 `exit` 事件 → 记录退出码与 stderr 摘要 → 触发 `onClose`。
5. `close()`：Windows 下 `taskkill /pid <pid> /T /F`（复用 `src/tools/bash.ts` 的 terminate 策略），其他平台 `kill("SIGTERM")`；已退出则跳过。
6. `send(text)`：向 stdin 写入 `text + "\n"`；stdin 已关闭则 reject。

**验证：** `bun run typecheck` 通过。

## T5: HttpTransport

**文件：** `src/mcp/transport-http.ts`
**依赖：** T1
**步骤：**
1. `class HttpTransport implements McpTransport`，构造参数 `(url, headers)`。
2. `send(text)`：`fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...自定义 headers }, body: text })`。
3. 响应 204/空体 → 视为成功无消息。
4. `content-type` 含 `text/event-stream` → 按行扫描，取 `data:` 前缀后的 JSON 文本，每条完整 JSON 喂 `onMessage`。
5. `content-type` 含 `application/json` → 整体 `JSON.parse`，喂 `onMessage`。
6. 非 2xx 或不可解析 → 触发 `onClose`（reason 含状态码或解析错误摘要）。
7. `close()` 为空操作（无长连接）。

**验证：** `bun run typecheck` 通过。

## T6: McpClient

**文件：** `src/mcp/client.ts`
**依赖：** T1, T3
**步骤：**
1. `class McpClient`，构造参数 `(config: McpServerConfig, transport: McpTransport)`；内部建 `JsonRpcConnection`。
2. `connect(): Promise<McpInitializeResult>`：发 `initialize` 请求，params 含 `protocolVersion: "2025-06-18"`、`capabilities: {}`、`clientInfo: { name: "MewCode", version: "0.1.0" }`；整体与 `timeout ?? 10_000` 竞速（`Promise.race`），超时 reject「握手超时」。
3. 握手成功后 `notify("notifications/initialized")`。
4. `listTools(): Promise<McpToolDef[]>`：`tools/list`，取 `result.tools ?? []`。
5. `callTool(name, args): Promise<McpCallToolResult>`：`tools/call`（params `{ name, arguments: args }`），与 `timeout ?? 60_000` 竞速；`connected === false` 时直接 reject「MCP Server 已断开」。
6. `transport.onClose` → `connected = false`。

**验证：** `bun run typecheck` 通过。

## T7: 规则层适配 MCP（plan D5，权限模块唯一改动）

**文件：** `src/permission/rules.ts`
**依赖：** T1（仅类型认知，无 import 依赖）
**步骤：**
1. `subjectFor`：当前对未知工具返回 `undefined`（导致规则永不匹配）。加一个分支——`toolName` 含 `.`（MCP 工具注册名的形态为 `Server名.工具名` 或冲突前缀 `Server名_工具名`）或不在 `PATH_ARG_BY_TOOL` 内的非 Bash 工具，返回参数的 `JSON.stringify(args)` 文本作为匹配主题。
   注意保守性：仅对「非内置六工具」走 JSON 主题分支，内置工具行为零变化。
2. `ruleTextFor`：同样对非内置工具生成 `工具名(JSON文本)` 形态；确认框与永久放行的规则文本可整串精确命中。
3. `matchRule` 无需改动（主题串到手后，精确比较与 `*` 通配逻辑通用）。
4. 跑既有 `tests/permission/rules.test.ts`，确认零回归。

**验证：** `bun run typecheck` 通过；`bun test tests/permission/rules.test.ts` 全绿。

## T8: McpToolAdapter

**文件：** `src/mcp/adapter.ts`
**依赖：** T1, T6
**步骤：**
1. `createMcpTool(serverName: string, client: McpClient, def: McpToolDef): Tool`。
2. `name = def.name`；`description = \`[MCP: ${serverName}] ${def.description ?? def.name}\``。
3. `parameters`：`normalizeSchema(def.inputSchema)`——缺 `type: "object"` 补上；`properties`/`required` 缺省补空；整体结构兜底为合法 `JSONSchemaObject`。
4. `readOnly = false`。
5. `callSummary(args)`：`Mcp(${serverName}.${def.name})`。
6. `execute(args, context)`：`client.callTool(def.name, args)`：
   - 成功：`content` 数组取 `type === "text"` 块按序拼接；非 text 块记 `[非文本内容块: <type>]` 占位行；拼出结果 `ok()`。
   - `isError === true` → `fail("exec_failed", "工具执行出错：" + 拼接文本)`。
   - JSON-RPC error / 超时 / 断开 reject → 上层 `runTool` 已统一转 `exec_failed`，这里不重复包装（保持 AbortError 穿透语义）。

**验证：** `bun run typecheck` 通过。

## T9: McpManager

**文件：** `src/mcp/manager.ts`
**依赖：** T4, T5, T6, T8
**步骤：**
1. `class McpManager`，`constructor(serverConfigs: Record<string, McpServerConfig>)`。
2. `connectAll(registry: ToolRegistry): Promise<McpServerReport[]>`：
   - `enabled === false` → `{ status: "disabled" }` 报告，不连接。
   - 其余按 `type` 建 Transport → `McpClient.connect()`（握手超时）→ `listTools()`，整体在 `Promise.race` 超时保护下并行执行（`Promise.allSettled`）。
   - 成功：每个工具经 `createMcpTool` 生成 Tool；注册名查 `registry.get()`，已存在则用 `${serverName}_${toolName}`；再冲突则跳过并记警告。报告 `{ status: "ok", toolCount, tools: [注册名列表] }`。
   - 失败/超时：`{ status: "failed", reason }` 或 `{ status: "timeout", timeoutMs }`；stdio 连接失败时销毁子进程。
3. `disposeAll(): Promise<void>`：遍历全部 Transport `close()`（stdio kill 子进程）。
4. 导出模块级单例访问 `getMcpManager()`（供 main 与测试使用）。

**验证：** `bun run typecheck` 通过。

## T10: main 启动接入 + App 呈现报告

**文件：** `src/main.tsx`、`src/tui/app.tsx`
**依赖：** T9
**步骤：**
1. `main.tsx`：`loadConfig()` 后创建 `McpManager`，`await connectAll(registry)`——registry 由 `createDefaultRegistry()` 创建后传入（阻塞启动，spec F4）；`process.on("exit")` 里调 `disposeAll()`（同步尽力清理，`disposeAll` 需提供同步路径或 fire-and-forget）。
   注意：main.tsx 是顶层 await 环境，`connectAll` 直接 await。
2. 报告数组传给 `<App mcpReports={...}>`。
3. `app.tsx`：新增可选 prop `mcpReports?: McpServerReport[]`；非空时在启动横幅后追加系统消息（每 Server 一条，按报告四态生成可区分文案；failed 带 reason）。复用现有 `role: "system"` 消息形态。
4. `useEffect` 依赖注意：报告是启动期一次性数据，直接初始化进 messages 初始值即可，不进 effect。

**验证：** `bun run typecheck` 通过；`bun run start` 手动观察（有 MCP 配置时）。

## T11: config 解析测试

**文件：** `tests/config.test.ts`
**依赖：** T2
**步骤：**
1. 用例：map 形态解析——stdio（command/args/env）与 http（url/headers）各一，字段齐全（AC1）。
2. 用例：`${VAR}` 展开——Server env 内前置引用、进程变量引用、未定义变量（空串 + 警告）（AC2）。
3. 用例：用户级与项目级同名 Server 键级覆盖（AC3 前半）。
4. 用例：非法 Server 项（缺 command/url）跳过且出警告，不抛异常（N4）。
5. 断言 `mergeConfig` 的键级覆盖语义。

**验证：** `bun test tests/config.test.ts` 全绿。

## T12: 规则层 MCP 用例

**文件：** `tests/permission/rules.test.ts`
**依赖：** T7
**步骤：**
1. 用例：`allow: Server1.query_database(*)` 命中对应参数 JSON（AC10 后半）。
2. 用例：`deny: Server1.query_database(模式)` 在 bypass 档下仍拒绝（AC11——decide 层测试放 T18 一并跑）。
3. 用例：内置六工具的规则行为零变化（既有用例回归）。

**验证：** `bun test tests/permission/rules.test.ts` 全绿。

## T13: jsonrpc 测试

**文件：** `tests/mcp/jsonrpc.test.ts`
**依赖：** T3
**步骤：**
1. 用例：请求-响应按 id 正确配对（并发 5 个乱序回包）。
2. 用例：无 id 通知被丢弃，不影响 pending（AC5）。
3. 用例：JSON-RPC error 响应 reject 且错误含服务端 message。
4. 用例：transport onClose 后 pending 全部 reject 且消息含 reason。
5. 用例：畸形 JSON 行静默丢弃。

**验证：** `bun test tests/mcp/jsonrpc.test.ts` 全绿。

## T14: transport 测试

**文件：** `tests/mcp/transport-stdio.test.ts`、`tests/mcp/transport-http.test.ts`
**依赖：** T4, T5
**步骤：**
1. stdio：用 `bun` 自身 spawn 一个回声脚本（tests 固定资产，如 `tests/mcp/fixtures/echo-server.ts`——读行、原样回写），验证收发往返（AC4 的传输基座）。
2. stdio：子进程退出 → onClose 触发。
3. stdio：close() 后子进程终止（AC6——用 `pid` 存活探测断言）。
4. http：用 `Bun.serve` 起本地桩——`application/json` 响应路径。
5. http：SSE 流式响应路径（`text/event-stream`，两条 `data:` 消息）。
6. http：非 2xx → onClose。

**验证：** `bun test tests/mcp/` 全绿。

## T15: client 测试

**文件：** `tests/mcp/client.test.ts`
**依赖：** T6, T14
**步骤：**
1. 用例：三步握手完整流程（initialize → initialized 通知 → tools/list）——用桩 transport 检查消息序列。
2. 用例：握手超时（timeout 配 10ms + 不回包的桩）reject「握手超时」。
3. 用例：tools/call 超时（60s 默认可被覆盖）。
4. 用例：断开后 callTool reject「MCP Server 已断开」（AC9）。
5. 用例：握手 params 携带 MewCode clientInfo 与协议版本。

**验证：** `bun test tests/mcp/client.test.ts` 全绿。

## T16: adapter 测试

**文件：** `tests/mcp/adapter.test.ts`
**依赖：** T8
**步骤：**
1. 用例：description 带 `[MCP: Server名]` 前缀（AC4 后半）。
2. 用例：schema 归一化——缺 type 补 object、空 schema。
3. 用例：多 text 块按序拼接；非 text 块出占位符（AC13 前半）。
4. 用例：`isError:true` → `fail` 且 errorKind 为 `exec_failed`（AC13 后半）。
5. 用例：`callSummary` 形态 `Mcp(server.tool)`。

**验证：** `bun test tests/mcp/adapter.test.ts` 全绿。

## T17: manager 测试（含重名与降级）

**文件：** `tests/mcp/manager.test.ts`
**依赖：** T9, T14
**步骤：**
1. 用例：两个 Server（stdio echo 桩 + http 桩）并行连接成功，报告均为 ok（AC4）。
2. 用例：一个 Server 握手挂起超 timeout → timeout 报告，另一个正常 ok（AC8）。
3. 用例：与内置工具重名（桩 Server 提供 `Read` 工具）→ 注册名变 `Server名_Read`，Agent 可调（AC7）。
4. 用例：`enabled: false` → disabled 报告、零连接尝试（AC3 后半）。
5. 用例：connectAll 后 `disposeAll` → stdio 子进程终止（AC6）。
6. 用例：调用已断开 Server 工具 → `runTool` 返回 `permission_denied` 之外的失败结果，循环不终止（AC9 集成形态，走 `runTool` 真链路）。

**验证：** `bun test tests/mcp/manager.test.ts` 全绿。

## T18: 五层判定集成用例（MCP 工具视角）

**文件：** `tests/mcp/manager.test.ts`（追加）或独立 `tests/mcp/permission-integration.test.ts`
**依赖：** T7, T9, T16
**步骤：**
1. 用例：默认档（无 confirm 回调）下 MCP 工具调用被拒（NO_INTERACTIVE 文案）；带 confirm 回调 → 兑付 once 放行（AC10 前半）。
2. 用例：配置 `allow: Server1.tool1(*)` 规则后直接放行不询问（AC10 后半）。
3. 用例：`deny` 规则在 bypass 档下仍拒绝（AC11）。
4. 用例：确认请求的 `ruleCandidate` 为 `Server1.tool1(...)` 形态，选「永久放行」后 `appendLocalRule` 落盘内容含 Server 前缀（AC12）。
5. 用例：MCP 工具出参经 `runTool` 截断（构造超长 text 块，断言 `[truncated` 标记，AC14）。

**验证：** `bun test tests/mcp/` 全绿。

## T19: 全量回归 + 启动链路验证

**文件：** 无（只跑验证）
**依赖：** T1–T18
**步骤：**
1. `bun run typecheck` 全过。
2. `bun test` 全绿（含既有 209 用例零回归）。
3. 写一个最小 stdio MCP Server 脚本（`tests/mcp/fixtures/` 内，用 Bun 实现 initialize/tools/list/tools/call 最小响应），配置进临时 `.mewcode/config.yaml`，`bun run start` 手动观察：系统消息出现连接报告、工具可被调用。
4. 观察退出后无残留子进程。

**验证：** 上述每步实际观察结果与预期一致。

## 执行顺序

```
T1 ──→ T2 ──→ T11
 │
 ├──→ T3 ──→ T13
 │
 ├──→ T4 ──→ T14 ──→ T15
 ├──→ T5 ──┘        │
 │                  ▼
 ├──→ T6 ──→ T15 ──→ T16 ──→ T17 ──→ T18 ──→ T19
 ├──→ T7 ──→ T12 ────────────────────┘
 └──→ T8 ──────────────────────────┘
T9（需 T4,T5,T6,T8）──→ T10 ──→ T19
```

关键路径：T1 → T3/T6 → T4/T5 → T14 → T16/T17 → T18 → T19。
T2/T11（配置）与 T7/T12（规则）两条支线不阻塞主链，可穿插。
