import { statSync } from "node:fs";
import { join, relative } from "node:path";
import { GLOB_MAX_RESULTS, IGNORED_DIRS } from "./limits.js";
import { resolveInside, toPosix } from "./paths.js";
import { fail, ok, stringArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const schema = {
  type: "object" as const,
  properties: {
    pattern: { type: "string" as const, description: "文件 glob 模式，例如 **/*.ts" },
    path: { type: "string" as const, description: "可选的工作目录内搜索根目录" },
  },
  required: ["pattern"],
};

function isIgnored(path: string): boolean {
  return toPosix(path).split("/").some((part) => IGNORED_DIRS.has(part));
}

async function execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const inputPath = stringArg(args, "path") || ".";
  const resolved = resolveInside(context.workDir, inputPath);
  if (!resolved.ok) return fail("out_of_scope", resolved.reason);

  const pattern = stringArg(args, "pattern");
  try {
    const glob = new Bun.Glob(pattern);
    const entries: Array<{ path: string; mtimeMs: number }> = [];
    for await (const entry of glob.scan({ cwd: resolved.absolute, onlyFiles: true, followSymlinks: false })) {
      if (isIgnored(entry)) continue;
      const absolute = join(resolved.absolute, entry);
      try {
        entries.push({ path: toPosix(relative(context.workDir, absolute)), mtimeMs: statSync(absolute).mtimeMs });
      } catch {
        // 枚举后被删除的文件跳过即可。
      }
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
    const truncated = entries.length > GLOB_MAX_RESULTS;
    const paths = entries.slice(0, GLOB_MAX_RESULTS).map((entry) => entry.path);
    if (paths.length === 0) return ok("没有匹配文件。", "no files matched", { count: 0 });
    const content = `${paths.join("\n")}${truncated ? `\n[truncated: showing ${GLOB_MAX_RESULTS} of ${entries.length} files]` : ""}`;
    return ok(content, `${paths.length}${truncated ? "+" : ""} files`, { count: entries.length, truncated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("invalid_params", `无效的 glob 模式：${message}`);
  }
}

export const GlobTool: Tool = {
  name: "Glob",
  description: "按 glob 模式查找工作目录内的文件，自动忽略依赖和构建产物目录。",
  parameters: schema,
  callSummary: (args) => `Glob(${JSON.stringify(stringArg(args, "pattern"))})`,
  execute,
};
