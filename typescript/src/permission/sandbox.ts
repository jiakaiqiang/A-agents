import { resolveInside } from "../tools/paths.js";
import type { Tool } from "../tools/types.js";
import { PATH_ARG_BY_TOOL } from "./limits.js";
import type { LayerResult } from "./types.js";

/**
 * 从命令字符串里识别路径样片段（spec F7）。
 * 只做文本识别：不展开变量、不求值、不模拟 shell 解析。
 * 已知会把 `grep -r ".." .` 里的 `..` 当成路径（spec 已知取舍）。
 */
export function extractPathCandidates(command: string): string[] {
  const quoted: string[] = [];
  const withoutQuotes = command.replace(/(?:"([^"]*)"|'([^']*)')/g, (_full, doubleQuoted, singleQuoted) => {
    quoted.push((doubleQuoted ?? singleQuoted) as string);
    return " ";
  });

  const tokens = withoutQuotes
    .split(/\s*(?:&&|\|\||;|\|)\s*|\s+/)
    .filter((token) => token.length > 0);

  const candidates: string[] = [];
  for (const token of [...quoted, ...tokens]) {
    if (isOption(token)) continue;
    if (looksLikePath(token)) candidates.push(token);
  }
  return [...new Set(candidates)];
}

function isOption(token: string): boolean {
  return token.startsWith("-") && !token.includes("/") && !token.includes("\\");
}

function looksLikePath(token: string): boolean {
  if (token.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  return token.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * 第二层：路径沙箱（spec F6–F8）。
 * 文件类工具的路径参数与 Bash 命令文本里的路径片段都限制在工作目录内。
 * 本层永不返回 allow——通过沙箱不等于获得放行（spec F2、N2）。
 * 与各工具 execute 内部的 resolveInside 是有意重复：沙箱必须作为不可放开的独立层存在（plan P4）。
 */
export function checkSandbox(tool: Tool, args: Record<string, unknown>, workDir: string): LayerResult {
  if (tool.name === "Bash") {
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") return { verdict: "abstain" };
    for (const candidate of extractPathCandidates(command)) {
      const resolved = resolveInside(workDir, candidate);
      if (!resolved.ok) {
        return {
          verdict: "deny",
          reason: `命令中的路径超出工作目录，已拒绝访问：${candidate}`,
        };
      }
    }
    return { verdict: "abstain" };
  }

  const field = PATH_ARG_BY_TOOL[tool.name];
  if (!field) return { verdict: "abstain" };
  const value = args[field];
  if (typeof value !== "string") return { verdict: "abstain" };

  const resolved = resolveInside(workDir, value);
  if (!resolved.ok) {
    return { verdict: "deny", reason: resolved.reason };
  }
  return { verdict: "abstain" };
}
