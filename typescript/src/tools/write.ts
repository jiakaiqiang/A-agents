import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveInside } from "./paths.js";
import { fail, ok, stringArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const schema = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" as const, description: "要写入的相对文件路径" },
    content: { type: "string" as const, description: "写入文件的完整内容，会覆盖已有内容" },
  },
  required: ["file_path", "content"],
};

function execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const resolved = resolveInside(context.workDir, stringArg(args, "file_path"));
  if (!resolved.ok) return Promise.resolve(fail("out_of_scope", resolved.reason));

  const content = stringArg(args, "content");
  const existed = existsSync(resolved.absolute);
  try {
    mkdirSync(dirname(resolved.absolute), { recursive: true });
    writeFileSync(resolved.absolute, content, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(fail("exec_failed", `无法写入文件 ${resolved.display}：${message}`));
  }

  const lineCount = content === "" ? 0 : content.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(content, "utf8");
  const action = existed ? "updated" : "created";
  return Promise.resolve(ok(
    `${action} ${resolved.display} (${lineCount} lines, ${bytes} bytes)`,
    `${action}, ${lineCount} lines`,
    { path: resolved.display, lineCount, bytes, action },
  ));
}

export const WriteTool: Tool = {
  name: "Write",
  description: "创建或覆盖写入文本文件；不存在的父目录会自动创建。",
  parameters: schema,
  readOnly: false,
  callSummary: (args) => `Write(${stringArg(args, "file_path")})`,
  execute,
};
