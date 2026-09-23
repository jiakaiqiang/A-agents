// 单个 MCP Server 的会话（plan 模块 D）：三步握手、列工具、调工具。
// 超时用 Promise.race 竞速实现；断开后调用直接失败（spec F9、F10）。

import { JsonRpcConnection } from "./jsonrpc.js";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_HANDSHAKE_TIMEOUT_MS,
  type McpCallToolResult,
  type McpInitializeResult,
  type McpServerConfig,
  type McpToolDef,
  type McpTransport,
} from "./types.js";

export const MEWCODE_PROTOCOL_VERSION = "2025-06-18";
export const MEWCODE_CLIENT_INFO = { name: "MewCode", version: "0.1.0" };

/** 与给定超时竞速；超时 reject 且错误消息含毫秒数。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
      // 竞速结束后清掉定时器，避免进程悬挂。
      promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
    }),
  ]);
}
 
export class McpClient {
  private readonly connection: JsonRpcConnection;
  private ready = false;

  constructor(
    private readonly config: McpServerConfig,
    transport: McpTransport,
  ) {
    this.connection = new JsonRpcConnection(transport);
    transport.onClose(() => {
      this.ready = false;
    });
  }

  get connected(): boolean {
    return this.ready;
  }

  /**
   * 三步握手中的前两步：initialize 请求 → 成功后发 initialized 通知（spec F4）。
   * 第三步 tools/list 由调用方按需执行。整体受握手超时约束。
   */
  async connect(): Promise<McpInitializeResult> {
    const handshakeTimeout = this.config.timeout ?? MCP_HANDSHAKE_TIMEOUT_MS;
    const raw = await withTimeout(
      this.connection.send("initialize", {
        protocolVersion: MEWCODE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MEWCODE_CLIENT_INFO,
      }),
      handshakeTimeout,
      "握手",
    );

    if (raw === null || typeof raw !== "object") {
      throw new Error("握手响应格式错误");
    }
    await this.connection.notify("notifications/initialized");
    this.ready = true;
    return raw as McpInitializeResult;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.ready) throw new Error("MCP Server 未就绪");
    //请求tools/list，返回工具列表  这里是在mcp client 中去监听jsonrpc的消息，返回工具列表
    const raw = await this.connection.send("tools/list");
    const tools = (raw as { tools?: unknown } | null)?.tools;
    return Array.isArray(tools) ? (tools as McpToolDef[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    if (!this.ready) throw new Error("MCP Server 已断开");
    const callTimeout = this.config.timeout ?? MCP_CALL_TIMEOUT_MS;
    const raw = await withTimeout(
      this.connection.send("tools/call", { name, arguments: args }),
      callTimeout,
      "工具调用",
    );
    if (raw === null || typeof raw !== "object") {
      throw new Error("工具调用响应格式错误");
    }
    const result = raw as { content?: unknown; isError?: unknown };
    return {
      content: Array.isArray(result.content) ? (result.content as McpCallToolResult["content"]) : [],
      isError: result.isError === true,
    };
  }

  /** 供连接断开后直接置态（manager 在连接失败清理时使用）。 */
  markDisconnected(): void {
    this.ready = false;
  }
}
