// 最小 stdio MCP Server 回声桩：读行 → 原样回写（newline-delimited JSON 传输基座）。
// 供 transport-stdio 测试与 manager 集成测试使用。
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim()) process.stdout.write(`${line}\n`);
});
