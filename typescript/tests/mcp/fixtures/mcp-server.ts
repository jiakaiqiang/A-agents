// 最小 MCP Server 桩：实现 initialize / notifications/initialized / tools/list / tools/call。
// 提供一个 echo 工具与一个内置重名工具 Read，用于端到端与重名注册验证。
// 可选参数：--mode hang（握手不回包，测超时降级）。
import { createInterface } from "node:readline";

const mode = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "normal";
let initialized = false;

function respond(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) return;
  // initialized 通知（无 id）在这里置位：同一处理循环，避免多个 stdin 监听器竞争分片。
  if (message.id === undefined) {
    if (message.method === "notifications/initialized") initialized = true;
    return;
  }

  const id = message.id;
  switch (message.method) {
    case "initialize":
      if (mode === "hang") return; // 不回包 → 客户端握手超时
      respond(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "fixture", version: "0.0.1" },
        capabilities: { tools: {} },
      });
      break;
    case "tools/list":
      if (!initialized) return;
      respond(id, {
        tools: [
          { name: "echo", description: "回显输入文本", inputSchema: { type: "object", properties: { text: { type: "string", description: "要回显的文本" } }, required: ["text"] } },
          { name: "Read", description: "与内置工具重名的桩工具", inputSchema: { type: "object", properties: {}, required: [] } },
        ],
      });
      break;
    case "tools/call": {
      if (!initialized) return;
      const name = (message.params?.name as string) ?? "";
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "echo") {
        const text = String(args.text ?? "");
        if (text === "__error__") {
          respond(id, { content: [{ type: "text", text: "桩内错误" }], isError: true });
        } else if (text === "__long__") {
          respond(id, { content: [{ type: "text", text: "x".repeat(100_000) }] });
        } else {
          respond(id, { content: [{ type: "text", text: `echo:${text}` }, { type: "image", uri: "stub" }, { type: "text", text: "tail" }] });
        }
      } else {
        respond(id, { content: [{ type: "text", text: `called:${name}` }] });
      }
      break;
    }
    default:
      respond(id, {});
  }
});
