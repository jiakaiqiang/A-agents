// 适配层用例：描述前缀、schema 归一化、text 拼接、isError（spec F7、F14、AC4、AC13）。

import { describe, expect, test } from "bun:test";
import { contentToText, createMcpTool, normalizeSchema } from "../../src/mcp/adapter.js";
import { McpClient } from "../../src/mcp/client.js";
import type { McpTransport } from "../../src/mcp/types.js";
import type { Tool } from "../../src/tools/types.js";

function stubClient(respond: (method: string, params: Record<string, unknown>) => unknown): McpClient {
  let onMessage: ((text: string) => void) | null = null;
  const transport: McpTransport = {
    async send(text) {
      const message = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> };
      const result = respond(message.method, message.params ?? {});
      onMessage?.(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    },
    onMessage(callback) {
      onMessage = callback;
    },
    onClose() {},
    async close() {},
  };
  const client = new McpClient({ type: "stdio", enabled: true, command: "stub" }, transport);
  // 测试桩不经真实握手，直接置就绪态。
  (client as unknown as { ready: boolean }).ready = true;
  return client;
}

const toolDef = {
  name: "query_database",
  description: "查询数据库",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

describe("createMcpTool", () => {
  test("description 带 [MCP: Server名] 前缀（AC4）", () => {
    const tool = createMcpTool("db", stubClient(() => ({})), toolDef);
    expect(tool.name).toBe("query_database");
    expect(tool.description).toBe("[MCP: db] 查询数据库");
    expect(tool.readOnly).toBe(false);
  });

  test("description 缺省回退工具名", () => {
    const tool = createMcpTool("db", stubClient(() => ({})), { name: "t", inputSchema: {} });
    expect(tool.description).toBe("[MCP: db] t");
  });

  test("callSummary 形态 Mcp(server.tool)", () => {
    const tool = createMcpTool("db", stubClient(() => ({})), toolDef);
    expect(tool.callSummary({ query: "SELECT 1" })).toBe("Mcp(db.query_database)");
  });

  test("schema 归一化：缺 type 补 object、空 schema 兜底", () => {
    expect(normalizeSchema(undefined)).toEqual({ type: "object", properties: {}, required: [] });
    expect(normalizeSchema({ properties: { a: { type: "number", description: "x" } }, required: ["a"] })).toEqual({
      type: "object",
      properties: { a: { type: "number", description: "x" } },
      required: ["a"],
    });
  });

  test("多 text 块按序拼接，非 text 块记占位符（AC13）", () => {
    expect(contentToText([
      { type: "text", text: "first" },
      { type: "image", text: undefined },
      { type: "text", text: "tail" },
    ])).toBe("first\n[非文本内容块: image]\ntail");
  });

  test("execute：成功调用拼接 text 回灌", async () => {
    const client = stubClient((method) => {
      if (method === "tools/call") {
        return { content: [{ type: "text", text: "echo:hi" }] };
      }
      return {};
    });
    const tool = createMcpTool("db", client, toolDef);
    const result = await tool.execute({ query: "hi" }, { workDir: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("echo:hi");
  });

  test("execute：isError:true 转 fail 且 errorKind 为 exec_failed（AC13）", async () => {
    const client = stubClient((method) => {
      if (method === "tools/call") {
        return { content: [{ type: "text", text: "桩内错误" }], isError: true };
      }
      return {};
    });
    const tool = createMcpTool("db", client, toolDef);
    const result = await tool.execute({ query: "boom" }, { workDir: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("exec_failed");
    expect(result.content).toContain("桩内错误");
  });

  test("execute：JSON-RPC 断开 reject 由上层转失败（断开语义冒烟）", async () => {
    const client = stubClient(() => {
      throw new Error("MCP Server 已断开");
    });
    const tool: Tool = createMcpTool("db", client, toolDef);
    // execute 直接 reject；runTool 的 try/catch 会转 exec_failed，这里验证异常传播。
    await expect(tool.execute({ query: "x" }, { workDir: process.cwd() })).rejects.toThrow("MCP Server 已断开");
  });
});
