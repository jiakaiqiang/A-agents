import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolveInside, toPosix } from "./paths.js";
import { READ_MAX_LINES, READ_MAX_LINE_CHARS } from "./limits.js";
import { booleanArg, fail, numberArg, ok, stringArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const schema = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" as const, description: "待读文件的相对路径" },
    offset: { type: "integer" as const, description: "起始行号（从 0 开始），缺省为 0" },
    limit: { type: "integer" as const, description: `最多读取行数，缺省 ${READ_MAX_LINES}` },
  },
  required: ["file_path"],
};

function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = stringArg(args, "file_path");
  const resolved = resolveInside(ctx.workDir, filePath);
  if (!resolved.ok) return Promise.resolve(fail("out_of_scope", resolved.reason));

  if (!existsSync(resolved.absolute)) {
    return Promise.resolve(fail("not_found", `文件不存在：${resolved.display}`));
  }

  const stat = lstatSync(resolved.absolute);
  if (!stat.isFile()) {
    return Promise.resolve(fail("not_found", `路径指向目录或非常规文件：${resolved.display}`));
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolved.absolute);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(fail("exec_failed", `无法读取文件：${message}`));
  }

  if (buffer.includes(0)) {
    return Promise.resolve(fail("exec_failed", `文件含二进制内容：${resolved.display}`));
  }

  const text = buffer.toString("utf-8");
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;
  const offset = numberArg(args, "offset") ?? 0;
  const limit = numberArg(args, "limit") ?? READ_MAX_LINES;
  const start = Math.max(0, offset);
  const end = Math.min(totalLines, start + limit);
  const lines = allLines.slice(start, end);

  const formatted = lines
    .map((line, i) => {
      const lineNum = start + i + 1;
      const truncated = line.length > READ_MAX_LINE_CHARS ? `${line.slice(0, READ_MAX_LINE_CHARS)}…` : line;
      return `${lineNum}\t${truncated}`;
    })
    .join("\n");

  const range = end - start;
  const suffix = end < totalLines ? ` (total ${totalLines} lines, showing from line ${start + 1})` : "";
  return Promise.resolve(ok(formatted, `${range} lines${suffix}`, { path: resolved.display, lines: range }));
}

export const ReadTool: Tool = {
  name: "Read",
  description: "读取文本文件的内容，返回带行号的文本（1-indexed）。",
  parameters: schema,
  callSummary: (args) => `Read(${stringArg(args, "file_path")})`,
  execute,
};
