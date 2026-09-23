// McpClient 用例：三步握手序列、握手/调用超时、断开语义（spec F4、F9、F10、AC9）。

import { describe, expect, test } from "bun:test";
import { McpClient, MEWCODE_CLIENT_INFO, MEWCODE_PROTOCOL_VERSION } from "../../src/mcp/client.js";
import type { McpServerConfig, McpTransport } from "../../src/mcp/types.js";

/** 记录消息序列的桩：测试用脚本决定收到什么。 */
function scriptedTransport(script: (message: Record<string, unknown>, send: (text: string) => void) => void) {
  const sent: string[] = [];
  let onMessage: ((text: string) => void) | null = null;
  let onClose: ((reason: string) => void) | null = null;
  const transport: McpTransport = {
    async send(text) {
      sent.push(text);
      script(JSON.parse(text), (response: string) => onMessage?.(response));
    },
    onMessage(callback) {
      onMessage = callback;
    },
    onClose(callback) {
      onClose = callback;
    },
    async close() {},
  };
  return {
    transport,
    sent,
    emitClose: (reason: string) => onClose?.(reason),
  };
}

const baseConfig: McpServerConfig = { type: "stdio", enabled: true, command: "stub" };

describe("McpClient", () => {
  test("三步握手：initialize → initialized 通知（→ tools/list 由调用方发起）", async () => {
    const stub = scriptedTransport((message, send) => {
      if (message.method === "initialize") {
        send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: MEWCODE_PROTOCOL_VERSION, serverInfo: { name: "s", version: "1" }, capabilities: {} },
        }));
      }
      // initialized 通知无响应
    });
    const client = new McpClient(baseConfig, stub.transport);
    const result = await client.connect();
    expect(result.serverInfo.name).toBe("s");
    expect(client.connected).toBe(true);
    // 消息序列：initialize 请求 → initialized 通知
    const methods = stub.sent.map((text) => JSON.parse(text).method);
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
    // 握手 params 携带 MewCode clientInfo 与协议版本
    const initialize = JSON.parse(stub.sent[0]!);
    expect(initialize.params.protocolVersion).toBe(MEWCODE_PROTOCOL_VERSION);
    expect(initialize.params.clientInfo).toEqual(MEWCODE_CLIENT_INFO);
  });

  test("握手超时（timeout 配 10ms + 不回包）reject「握手超时」", async () => {
    const stub = scriptedTransport(() => undefined); // 永不回包
    const client = new McpClient({ ...baseConfig, timeout: 10 }, stub.transport);
    expect(async () => await client.connect()).toThrow("握手超时");
  });

  test("tools/list 返回 tools 数组", async () => {
    const stub = scriptedTransport((message, send) => {
      if (message.method === "initialize") {
        send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "s", version: "1" }, capabilities: {} } }));
      }
      if (message.method === "tools/list") {
        send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "t1", inputSchema: { type: "object" } }] } }));
      }
    });
    const client = new McpClient(baseConfig, stub.transport);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("t1");
  });

  test("tools/call 超时（timeout 覆盖 60s 默认）", async () => {
    const stub = scriptedTransport((message, send) => {
      if (message.method === "initialize") {
        send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "s", version: "1" }, capabilities: {} } }));
      }
      // tools/call 不回包
    });
    const client = new McpClient({ ...baseConfig, timeout: 20 }, stub.transport);
    await client.connect();
    expect(async () => await client.callTool("t", {})).toThrow("工具调用超时");
  });

  test("断开后 callTool reject「MCP Server 已断开」（AC9）", async () => {
    const stub = scriptedTransport((message, send) => {
      if (message.method === "initialize") {
        send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "s", version: "1" }, capabilities: {} } }));
      }
    });
    const client = new McpClient(baseConfig, stub.transport);
    await client.connect();
    stub.emitClose("子进程退出");
    expect(client.connected).toBe(false);
    expect(async () => await client.callTool("t", {})).toThrow("MCP Server 已断开");
  });
});
