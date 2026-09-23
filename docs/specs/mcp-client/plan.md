# MCP 客户端 Plan

## 架构概览

```
配置层                连接层（src/mcp/）                  消费层
┌───────────┐   ┌──────────────────────────────┐   ┌──────────────┐
│ config.ts  │──→│ McpManager（单例，生命周期）    │──→│ ToolRegistry │
│mcp_servers │   │  ├─ McpClient（每 Server 一个） │   │ （工具注册）  │
└───────────┘   │      ├─ JsonRpcConnection      │   └──────────────┘
                │      │    └─ Transport         │              │
                └──────────────────────────────┘    ┌──────────────┐
                                     ↑              │  Agent Loop  │
                                     └── runTool 统一入口 ←───────┘
```

五个模块：

- **McpManager**：单例管理器，持有全部连接。启动时并行连接所有启用的 Server、注册工具到 Registry、对外报告连接结果；进程退出时统一清理。
- **McpClient**：单个 Server 的会话。执行三步握手（initialize → initialized 通知 → tools/list），暴露 `callTool`；知道自己的超时与配置。
- **Transport（stdio / http 两个实现）**：只管字节流的收发。stdio 用 `child_process.spawn`，http 用 `fetch`。不解析 JSON-RPC。
- **JsonRpcConnection**：协议核心。收发队列 + 按 id 配对 pending 请求；收到无 id 消息静默丢弃。
- **McpToolAdapter**：把 McpClient 上的一个远端工具包装成 MewCode `Tool` 接口，交给注册表；权限、截断、脱敏全部由现有 `runTool` 管线天然覆盖。

## 核心数据结构

### McpServerConfig（src/mcp/types.ts）

```typescript
export interface McpServerConfig {
  type: "stdio" | "http";
  enabled: boolean;          // 默认 true
  timeout?: number;          // 毫秒；覆盖握手默认 10s 与调用默认 60s
  // stdio 专用
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http 专用
  url?: string;
  headers?: Record<string, string>;
}
```

### 协议消息形态（src/mcp/jsonrpc.ts）

```typescript
// JSON-RPC 2.0 标准形态
interface JsonRpcRequest      { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
interface JsonRpcResponse     { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } }
interface JsonRpcNotification { jsonrpc: "2.0"; method: string; params?: unknown } // 无 id → 静默丢弃
```

### MCP 握手与工具定义（src/mcp/types.ts）

```typescript
export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentBlock { type: string; text?: string }  // 只消费 text 块

export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export type McpServerReport =
  | { name: string; status: "ok"; toolCount: number; tools: string[] }
  | { name: string; status: "disabled" }
  | { name: string; status: "failed"; reason: string }
  | { name: string; status: "timeout"; timeoutMs: number };
```

### 接口：Transport

```typescript
export interface McpTransport {
  send(text: string): Promise<void>;
  onMessage(callback: (text: string) => void): void;
  onClose(callback: (reason: string) => void): void;
  close(): Promise<void>;
}
```

## 模块设计

### 模块 A：配置解析（修改 src/config/config.ts）

**职责：** 把 YAML 里的 `mcp_servers` map 解析成强类型配置，做字段校验与 `${VAR}` 展开。
**对外接口：**
- `parseMcpServers(raw: unknown): { servers: Map<string, McpServerConfig>; warnings: string[] }`
- `expandEnvVars(value: string, lookup: (name: string) => string | undefined): { value: string; warnings: string[] }`
**依赖：** 无（纯函数）。
**变更要点：** `loadSingleFile` 里 `mcp_servers` 的读取从「数组取 `name` 字段」改为「map 取 key」；`mergeConfig` 改为对 map 的键级覆盖；两个函数的签名不变，`AppConfig.mcp_servers` 类型改为 `Map<string, McpServerConfig>` 的普通对象形态 `Record<string, McpServerConfig>`（YAML 解析后即对象）。

### 模块 B：JsonRpcConnection（新建 src/mcp/jsonrpc.ts）

**职责：** JSON-RPC 2.0 核心——发出请求并返回按 id 配对的 Promise；分发收到的消息（响应喂给配对表，通知静默丢弃）。
**对外接口：**
- `class JsonRpcConnection`
  - `constructor(transport: McpTransport)`
  - `send(method: string, params?: unknown): Promise<unknown>` — 分配自增 id，写入配对表，经 transport 发出；transport onClose 时全部 pending reject
  - `notify(method: string, params?: unknown): Promise<void>` — 发无 id 消息，不进配对表
  - `handleMessage(text: string): void` — 解析一行；有 id 喂配对表，无 id 丢弃；解析失败丢弃不抛
  - `onClose(reason)` → reject 所有 pending（错误信息含 reason）
**依赖：** 注入的 `McpTransport`。

### 模块 C：Transport（新建 src/mcp/transport-stdio.ts、transport-http.ts）

**职责：** 只管字节流收发，不解析 JSON-RPC。

**StdioTransport**
- `constructor(command, args, env, cwd)` — spawn 子进程，`windowsHide: true`；Windows 下用 `shellFor` 同款思路不必（Server 命令是可执行文件，不经 shell）
- stdout 按行分割喂 `onMessage` 回调；stderr 收集用于失败文案（截断到 500 字符）
- 监听 `exit` 事件 → 触发 `onClose`
- `close()`：Windows 下 `taskkill /pid X /T /F`，其他平台 `kill("SIGTERM")`（与 bash.ts 的 `terminate` 同策略）

**HttpTransport**
- `constructor(url, headers)`
- `send(text)`：`fetch(url, { method: "POST", headers, body: text })`
- 响应处理：`content-type: application/json` → 整体作为一条消息喂 `onMessage`；`text/event-stream` → 按 `data:` 行提取 JSON 喂 `onMessage`；其他 → 视为传输错误
- 无长连接：每次请求独立；`onClose` 仅在连续传输错误时触发；`close()` 为空操作
**依赖：** 无（标准库）。

### 模块 D：McpClient（新建 src/mcp/client.ts）

**职责：** 单个 Server 的会话状态机：握手三步、列工具、调工具；持有断开状态与超时。
**对外接口：**
- `class McpClient`
  - `constructor(config: McpServerConfig, transport: McpTransport)`
  - `connect(): Promise<McpInitializeResult>` — `initialize` 请求（携带 MewCode 协议版本 `2025-06-18` 与能力声明）→ 成功后发 `notifications/initialized` 通知 → 视为就绪；握手整体受 `timeout ?? 10_000` 约束
  - `listTools(): Promise<McpToolDef[]>` — `tools/list`，取 `result.tools`
  - `callTool(name, args): Promise<McpCallToolResult>` — `tools/call`，受 `timeout ?? 60_000` 约束
  - `connected: boolean` — transport onClose 后置 false；之后 `callTool` 直接抛「MCP Server 已断开」
**依赖：** JsonRpcConnection + Transport。

### 模块 E：McpManager + Adapter（新建 src/mcp/manager.ts、adapter.ts）

**职责：** Manager 并行连接全部 Server（`Promise.allSettled` + 每 Server 独立超时竞速）、把成功 Server 的工具经 Adapter 注册进 ToolRegistry、汇总连接结果；进程退出钩子关闭全部连接。Adapter 生成 MewCode Tool 对象。
**对外接口：**
- `class McpManager`
  - `connectAll(registry: ToolRegistry): Promise<McpServerReport[]>` — 对启用的 Server 并行 connect + listTools + 注册
  - `disposeAll(): Promise<void>` — 关闭全部连接（stdio kill、http 无操作）
- `createMcpTool(serverName: string, client: McpClient, def: McpToolDef): Tool` — Adapter 工厂
**依赖：** 模块 B/C/D + 现有 `ToolRegistry`、`tools/types.ts` 的 `Tool`。

**Adapter 细节：**
- `name`：工具原名（重名前缀由 Manager 注册时判定，Adapter 不知情）
- `description`：`[MCP: ${serverName}] ${def.description ?? tool name}`
- `parameters`：把 Server 给的 JSON Schema 归一化为 MewCode 的 `JSONSchemaObject`（见技术决策 D6）
- `readOnly`：恒 `false`
- `callSummary(args)`：`Mcp(server.工具名)` 形态的一行摘要
- `execute`：`client.callTool` → content text 块拼接（非 text 块记 `[非文本内容块: <type>]` 占位）→ `isError` 或 JSON-RPC error 时 `fail("exec_failed", ...)`，否则 `ok()`

## 模块交互

```
启动（main.tsx）
  │ loadConfig() 得到 mcp_servers map
  ▼
McpManager.connectAll(registry)          ← 并行，每 Server 独立超时
  │  每 Server：
  │  1. 按 type 建 Transport（stdio: spawn 子进程 / http: 无状态）
  │  2. JsonRpcConnection 包住 Transport
  │  3. McpClient.connect()：initialize → initialized 通知 → tools/list
  │  4. 工具经 Adapter 注册进 Registry（重名 → Server名_工具名）
  ▼
McpServerReport[] → App 作系统消息呈现（spec F16）
  │
  ▼
会话中：Agent Loop → runTool → registry.get(name) → McpToolAdapter.execute()
  │        （五层判定已在 runTool 内：黑名单非 Bash 不表态；沙箱查 PATH_ARG_BY_TOOL
  │          不命中即不表态——现有代码已天然如此，零改动，见 D3/D4）
  ▼
callTool → JsonRpcConnection.send("tools/call") → Transport → Server
  ▼
响应 → content text 拼接 → ToolResult → runTool 截断/脱敏 → 回灌模型

退出：process.on("exit") → Manager.disposeAll() → stdio kill 子进程
```

## 文件组织

```
typescript/
├── src/
│   ├── config/config.ts        — 修改：mcp_servers map 解析 + ${VAR} 展开 + mergeConfig 键级覆盖
│   ├── mcp/
│   │   ├── types.ts            — 新建：McpServerConfig、McpToolDef、CallToolResult、报告类型
│   │   ├── jsonrpc.ts          — 新建：JsonRpcConnection
│   │   ├── transport-stdio.ts  — 新建：子进程管道传输
│   │   ├── transport-http.ts   — 新建：Streamable HTTP 传输
│   │   ├── client.ts           — 新建：McpClient 三步握手 + callTool
│   │   ├── manager.ts          — 新建：并行连接、注册、汇总报告、退出清理
│   │   └── adapter.ts          — 新建：远端工具 → MewCode Tool 包装
│   ├── main.tsx                — 修改：启动时 connectAll，报告传给 App
│   └── tui/app.tsx             — 修改：接收报告 prop，作系统消息呈现
└── tests/
    ├── config.test.ts          — 修改：mcp_servers map 解析用例
    └── mcp/
        ├── jsonrpc.test.ts     — id 配对、通知丢弃、断开 reject
        ├── transport-stdio.test.ts
        ├── transport-http.test.ts
        ├── client.test.ts      — 握手三步、超时、断开
        ├── adapter.test.ts     — 包装、前缀、text 拼接、isError
        └── manager.test.ts     — 并行连接、降级、重名前缀、退出清理
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| D1 协议实现 | 自研 JSON-RPC 2.0，零依赖 | 用户明确选择；项目定位自研学习 |
| D2 启动模式 | 阻塞启动，连接完再进聊天 | 用户选择；首轮对话工具即全量可用 |
| D3 黑名单 | 不改权限代码 | 现有 `checkBlacklist` 只认 `tool.name === "Bash"`，MCP 工具天然不表态（已核实 blacklist.ts:10） |
| D4 沙箱 | 不改权限代码 | 现有 `checkSandbox` 对非 Bash 工具查 `PATH_ARG_BY_TOOL[tool.name]`，MCP 工具名不在表内即返回不表态（已核实 sandbox.ts:62） |
| D5 规则层 | 需要小改 `subjectFor` | MCP 工具规则主题是「整个参数 JSON 文本」；`rules.ts:34` 的 `subjectFor` 对未知工具返回 undefined 导致永不匹配——为 MCP 工具加一个分支：非内置工具返回参数 JSON 序列化文本；同时 `ruleTextFor` 需能生成 `Server名.工具名(pattern)` 文本。此为权限模块唯一改动点 |
| D6 参数 Schema | Server 的 inputSchema 直接透传 + 最小归一化 | MewCode 的 `validate()`（schema.ts）要求 `type/properties/required` 形态；Server 给的 JSON Schema 大体兼容。归一化规则：缺 `type: "object"` 时补上；`properties` 内字段非 MewCode 认识的类型（如纯 `{"type":"array"}` 无 items）保持原样，`validate` 不认识的字段不会崩（只按 type 判断）。Server 未给 schema 的工具用空 schema（无参数） |
| D7 id 生成 | 连接内自增整数 | 简单；每连接独立命名空间 |
| D8 stdio 分帧 | 按行分割 | MCP stdio 传输标准为 newline-delimited JSON |
| D9 HTTP 响应 | 兼容 `application/json` 与 `text/event-stream` | Streamable HTTP 规范允许两种；SSE 按 `data:` 行提取 |
| D10 连接持有 | Manager 单例 + exit 钩子清理 | 会话中不拆连接；N3 僵尸进程要求 |
| D11 超时实现 | `Promise.race` 竞速 | 握手与调用分别竞速各自超时；超时只 reject 该 Promise，不杀连接（握手超时除外——连接整体判失败） |
| D12 命名冲突 | 注册时查 Registry 已有名，冲突则 `Server名_工具名` | Manager 统一处理，Adapter 不知情 |
