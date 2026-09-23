// MCP 客户端的类型定义（spec F1–F16）。
// 本模块不依赖 TUI；确认交互走既有权限系统的回调管线。

/** Server 连接配置（spec F1）。YAML map 的每个值经解析归一化而来。 */
export interface McpServerConfig {
  type: "stdio" | "http";
  enabled: boolean; // 默认 true（spec F3）
  timeout?: number; // 毫秒；覆盖握手默认 10s 与调用默认 60s（spec F9、F10）
  // stdio 专用
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http 专用
  url?: string;
  headers?: Record<string, string>;
}

/** initialize 请求的响应（spec F4）。 */
export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

/** tools/list 返回的单个工具定义。 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** content 数组里的一个内容块；本期只消费 text 块（spec F14）。 */
export interface McpContentBlock {
  type: string;
  text?: string;
}

/** tools/call 的结果。 */
export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * 单个 Server 的连接报告（spec F16）。
 * 四态互斥：disabled 表示配置声明了 enabled:false，未发起任何连接。
 */
export type McpServerReport =
  | { name: string; status: "ok"; toolCount: number; tools: string[] }
  | { name: string; status: "disabled" }
  | { name: string; status: "failed"; reason: string }
  | { name: string; status: "timeout"; timeoutMs: number };

/**
 * 传输层抽象（plan 模块 C）：只管字节流收发，不解析 JSON-RPC。
 * stdio 实现按行分帧，http 实现按响应体切消息。
 */
export interface McpTransport {
  send(text: string): Promise<void>;
  onMessage(callback: (text: string) => void): void;
  onClose(callback: (reason: string) => void): void;
  close(): Promise<void>;
}

/** 默认超时：握手 10s、工具调用 60s（spec F9、F10），均可被 Server 的 timeout 覆盖。 */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
