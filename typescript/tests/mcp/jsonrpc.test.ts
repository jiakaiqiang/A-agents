// JSON-RPC 连接层用例：id 配对、通知丢弃、断开兑付、畸形消息（spec F5、N6）。

import { describe, expect, test } from "bun:test";
import { JsonRpcConnection } from "../../src/mcp/jsonrpc.js";
import type { McpTransport } from "../../src/mcp/types.js";

/** 可编程桩：记录发出的文本，允许测试手动注入收到的消息与断开事件。 */
function stubTransport() {
  const sent: string[] = [];
  let onMessage: ((text: string) => void) | null = null;
  let onClose: ((reason: string) => void) | null = null;
  const transport: McpTransport = {
    async send(text) {
      sent.push(text);
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
    receive(text: string) {
      onMessage?.(text);
    },
    emitClose(reason: string) {
      onClose?.(reason);
    },
  };
}

describe("JsonRpcConnection", () => {
  test("请求-响应按 id 正确配对（并发 5 个乱序回包）", async () => {
    const stub = stubTransport();
    const connection = new JsonRpcConnection(stub.transport);
    const pending = [1, 2, 3, 4, 5].map((n) => connection.send(`method${n}`, { n }).then((result) => ({ n, result })));

    // 全部已发出且 id 递增
    expect(stub.sent).toHaveLength(5);
    expect(JSON.parse(stub.sent[0]!).id).toBe(1);
    expect(JSON.parse(stub.sent[4]!).id).toBe(5);

    // 乱序回包
    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, result: "r3" }));
    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "r1" }));
    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 5, result: "r5" }));
    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "r2" }));
    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 4, result: "r4" }));

    const results = await Promise.all(pending);
    expect(results.map((item) => item.result)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("无 id 通知被丢弃，不影响 pending（AC5）", async () => {
    const stub = stubTransport();
    const connection = new JsonRpcConnection(stub.transport);
    const first = connection.send("tools/list");

    stub.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }));
    stub.receive(JSON.stringify({ jsonrpc: "2.0", method: "some/other" }));
    expect(connection.pendingCount).toBe(1);

    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    expect(await first).toEqual({ tools: [] });
  });

  test("JSON-RPC error 响应 reject 且错误含服务端 message", async () => {
    const stub = stubTransport();
    const connection = new JsonRpcConnection(stub.transport);
    const request = connection.send("tools/call").catch((error: Error) => error);
    stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "内部错误" } }));
    const error = await request;
    expect(String(error)).toContain("内部错误");
  });

  test("transport onClose 后 pending 全部 reject 且消息含 reason", async () => {
    const stub = stubTransport();
    const connection = new JsonRpcConnection(stub.transport);
    const first = connection.send("a").catch((error: Error) => error);
    const second = connection.send("b").catch((error: Error) => error);
    stub.emitClose("子进程退出（退出码 1）");
    const firstError = await first;
    const secondError = await second;
    expect(String(firstError)).toContain("子进程退出");
    expect(String(secondError)).toContain("子进程退出");
    expect(connection.pendingCount).toBe(0);
  });

  test("断开后 send 直接 reject", async () => {
    const stub = stubTransport();
    const connection = new JsonRpcConnection(stub.transport);
    stub.emitClose("断开");
    expect(async () => await connection.send("tools/list")).toThrow("连接已关闭");
  });

  test("畸形 JSON 行静默丢弃", () => {
    const stub = stubTransport();
    const connection = new JsonRpcConnection(stub.transport);
    expect(() => {
      stub.receive("not-json {{{");
      stub.receive(JSON.stringify(["array", "top-level"]));
      stub.receive(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "unknown-id" }));
    }).not.toThrow();
    expect(connection.pendingCount).toBe(0);
  });
});
