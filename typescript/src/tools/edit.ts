import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolveInside } from "./paths.js";
import { booleanArg, fail, ok, stringArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const schema = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" as const, description: "要编辑的相对文件路径" },
    old_string: { type: "string" as const, description: "必须精确匹配的原文片段" },
    new_string: { type: "string" as const, description: "替换后的新文本" },
    replace_all: { type: "boolean" as const, description: "是否替换所有匹配项，默认 false" },
  },
  required: ["file_path", "old_string", "new_string"],
};

function normalizeNewlines(value: string, useCrLf: boolean): string {
  if (!useCrLf) return value;
  return value.replace(/\r?\n/g, "\r\n");
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const resolved = resolveInside(context.workDir, stringArg(args, "file_path"));
  if (!resolved.ok) return Promise.resolve(fail("out_of_scope", resolved.reason));
  if (!existsSync(resolved.absolute)) return Promise.resolve(fail("not_found", `文件不存在：${resolved.display}`));
  if (!lstatSync(resolved.absolute).isFile()) {
    return Promise.resolve(fail("not_found", `路径指向目录或非常规文件：${resolved.display}`));
  }

  const oldString = stringArg(args, "old_string");
  const newString = stringArg(args, "new_string");
  if (oldString === "") return Promise.resolve(fail("invalid_params", "old_string 不能为空"));
  if (oldString === newString) return Promise.resolve(fail("invalid_params", "old_string 与 new_string 不能相同"));

  let original: string;
  try {
    original = readFileSync(resolved.absolute, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(fail("exec_failed", `无法读取文件：${message}`));
  }

  const matches = original.split(oldString).length - 1;
  if (matches === 0) {
    return Promise.resolve(fail("not_found", `未找到原文片段，请先用 Read 确认内容：${resolved.display}`, { matches }));
  }

  const replaceAll = booleanArg(args, "replace_all");
  if (matches > 1 && !replaceAll) {
    return Promise.resolve(fail(
      "match_count",
      `找到 ${matches} 处匹配，期望恰好 1 处；可使用 replace_all 进行全量替换`,
      { matches },
    ));
  }

  const replacement = normalizeNewlines(newString, original.includes("\r\n"));
  const updated = replaceAll
    ? original.split(oldString).join(replacement)
    : `${original.slice(0, original.indexOf(oldString))}${replacement}${original.slice(original.indexOf(oldString) + oldString.length)}`;

  try {
    writeFileSync(resolved.absolute, updated, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(fail("exec_failed", `无法写回文件：${message}`));
  }

  const suffix = matches === 1 ? "occurrence" : "occurrences";
  return Promise.resolve(ok(
    `已在 ${resolved.display} 替换 ${matches} 处匹配`,
    `replaced ${matches} ${suffix}`,
    { path: resolved.display, matches },
  ));
}

export const EditTool: Tool = {
  name: "Edit",
  description: "在文本文件中精确替换原文片段，默认要求原文恰好匹配一次，可选全量替换。编辑前必须先用 Read 确认当前内容，old_string 要照原文逐字节写。文件路径使用相对于工作目录的相对路径。",
  parameters: schema,
  readOnly: false,
  callSummary: (args) => `Edit(${stringArg(args, "file_path")})`,
  execute,
};
