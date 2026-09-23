// Streamable HTTP 传输用例：JSON 响应、SSE 流式响应、非 2xx 断开（spec F4、AC4）。

import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import { HttpTransport } from "../../src/mcp/transport-http.js";

function startServer(handler: (request: Request) => Response): { server: ReturnType<typeof serve>; url: string } {
  const server = serve({ port: 0, fetch: (request) => handler(request) });
  return { server, url: `http://localhost:${server.port}/rpc` };
}

describe("HttpTransport", () => {
  test("application/json 响应整体喂给 onMessage", async () => {
    const { server, url } = startServer(
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = new HttpTransport(url);
    const received: string[] = [];
    transport.onMessage((text) => received.push(text));
    transport.onClose(() => undefined);
    await transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).result).toEqual({ ok: true });
    server.stop(true);
  });

  test("text/event-stream 响应按 data: 行提取（SSE）", async () => {
    const sseBody = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":"first"}\n\n data-not-json \ndata: {"jsonrpc":"2.0","id":2,"result":"second"}\n`;
    const { server, url } = startServer(
      () => new Response(sseBody, { headers: { "content-type": "text/event-stream" } }),
    );
    const transport = new HttpTransport(url);
    const received: string[] = [];
    transport.onMessage((text) => received.push(text));
    transport.onClose(() => undefined);
    await transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }));
    expect(received.map((text) => JSON.parse(text).result)).toEqual(["first", "second"]);
    server.stop(true);
  });

  test("204 无响应体视为成功", async () => {
    const { server, url } = startServer(() => new Response(null, { status: 204 }));
    const transport = new HttpTransport(url);
    let received = 0;
    transport.onMessage(() => received++);
    transport.onClose(() => undefined);
    await transport.send("{}");
    expect(received).toBe(0);
    server.stop(true);
  });

  test("非 2xx 触发 onClose 且 send reject", async () => {
    const { server, url } = startServer(() => new Response("boom", { status: 500 }));
    const transport = new HttpTransport(url);
    const closed = new Promise<string>((resolve) => transport.onClose(resolve));
    await expect(transport.send("{}")).rejects.toThrow("HTTP 500");
    expect(await closed).toBe("HTTP 500");
    server.stop(true);
  });
});
