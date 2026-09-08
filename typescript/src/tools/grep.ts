import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { GREP_MAX_FILE_BYTES, GREP_MAX_LINE_CHARS, GREP_MAX_MATCHES, IGNORED_DIRS } from "./limits.js";
import { resolveInside, toPosix } from "./paths.js";
import { booleanArg, fail, ok, stringArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const schema = {
  type: "object" as const,
  properties: {
    pattern: { type: "string" as const, description: "要搜索的 JavaScript 正则表达式模式" },
    path: { type: "string" as const, description: "可选的工作目录内搜索根目录" },
    glob: { type: "string" as const, description: "可选的文件名 glob 过滤，例如 **/*.ts" },
    "-i": { type: "boolean" as const, description: "是否忽略大小写" },
    output_mode: {
      type: "string" as const,
      description: "输出模式：content、files_with_matches 或 count",
      enum: ["content", "files_with_matches", "count"],
    },
  },
  required: ["pattern"],
};

interface Match {
  path: string;
  line: number;
  text: string;
}

function isIgnored(path: string): boolean {
  return toPosix(path).split("/").some((part) => IGNORED_DIRS.has(part));
}

function output(matches: Match[], mode: string): string {
  if (mode === "files_with_matches") {
    return [...new Set(matches.map((match) => match.path))].join("\n");
  }
  if (mode === "count") {
    const countByPath = new Map<string, number>();
    for (const match of matches) countByPath.set(match.path, (countByPath.get(match.path) ?? 0) + 1);
    return [...countByPath.entries()].map(([path, count]) => `${path}:${count}`).join("\n");
  }
  return matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n");
}

async function execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const inputPath = stringArg(args, "path") || ".";
  const resolved = resolveInside(context.workDir, inputPath);
  if (!resolved.ok) return fail("out_of_scope", resolved.reason);

  const pattern = stringArg(args, "pattern");
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, booleanArg(args, "-i") ? "i" : "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("invalid_params", `无效的搜索模式：${message}`);
  }

  const matches: Match[] = [];
  let truncated = false;
  try {
    const glob = new Bun.Glob(stringArg(args, "glob") || "**/*");
    outer: for await (const entry of glob.scan({ cwd: resolved.absolute, onlyFiles: true, followSymlinks: false })) {
      if (isIgnored(entry)) continue;
      const absolute = join(resolved.absolute, entry);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.size > GREP_MAX_FILE_BYTES) continue;

      let text: string;
      try {
        text = readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;

      const displayPath = toPosix(relative(context.workDir, absolute));
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        matcher.lastIndex = 0;
        if (!matcher.test(line)) continue;
        matches.push({
          path: displayPath,
          line: index + 1,
          text: line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line,
        });
        if (matches.length >= GREP_MAX_MATCHES) {
          truncated = true;
          break outer;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("exec_failed", `搜索失败：${message}`);
  }

  if (matches.length === 0) return ok("没有匹配内容。", "no matches", { count: 0 });
  const mode = stringArg(args, "output_mode") || "content";
  const content = `${output(matches, mode)}${truncated ? `\n[truncated: showing first ${GREP_MAX_MATCHES} matches]` : ""}`;
  const fileCount = new Set(matches.map((match) => match.path)).size;
  return ok(content, `${matches.length}${truncated ? "+" : ""} matches in ${fileCount} files`, {
    count: matches.length,
    fileCount,
    truncated,
  });
}

export const GrepTool: Tool = {
  name: "Grep",
  description: "使用正则表达式搜索工作目录内文件内容，返回文件路径、行号和命中行。",
  parameters: schema,
  readOnly: true,
  callSummary: (args) => `Grep(${JSON.stringify(stringArg(args, "pattern"))})`,
  execute,
};
