import { toPosix } from "../tools/paths.js";
import type { Tool } from "../tools/types.js";
import { PATH_ARG_BY_TOOL } from "./limits.js";
import type { LayerResult, Rule, RuleSet, RuleSource } from "./types.js";

const LAYER_ORDER: RuleSource[] = ["session", "local", "project", "user"];

/**
 * 解析「工具名(模式)」（spec F9）。
 * 取首个 `(` 与末个 `)`，允许模式内含括号；`)` 必须落在字符串末尾。
 */
export function parseRule(
  text: string,
  effect: "allow" | "deny",
  source: RuleSource,
  order: number,
): Rule | undefined {
  const trimmed = text.trim();
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open <= 0 || close !== trimmed.length - 1) return undefined;
  const tool = trimmed.slice(0, open).trim();
  const pattern = trimmed.slice(open + 1, close).trim();
  if (tool === "" || pattern === "") return undefined;
  return { tool, pattern, effect, source, order };
}

/** `*` 跨任意字符匹配，不做 `*` 与 `**` 的区分（spec 未要求）。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

function subjectFor(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "Bash") {
    return typeof args.command === "string" ? args.command : undefined;
  }
  const field = PATH_ARG_BY_TOOL[toolName];
  if (!field) return undefined;
  const value = args[field];
  return typeof value === "string" ? toPosix(value) : undefined;
}

export function matchRule(rule: Rule, toolName: string, args: Record<string, unknown>): boolean {
  if (rule.tool !== toolName) return false;
  const subject = subjectFor(toolName, args);
  if (subject === undefined) return false;
  if (!rule.pattern.includes("*")) return subject === rule.pattern;
  return globToRegExp(rule.pattern).test(subject);
}

/**
 * 第三层：按四层来源查找（spec F12、F13）。
 * 高优先级层命中即定；同层内取 order 最大的命中项（书写靠后的赢）。
 */
export function checkRules(rules: RuleSet, toolName: string, args: Record<string, unknown>): LayerResult {
  for (const source of LAYER_ORDER) {
    const hits = rules.layers[source].filter((rule) => matchRule(rule, toolName, args));
    if (hits.length === 0) continue;
    const winner = hits.reduce((current, next) => (next.order >= current.order ? next : current));
    if (winner.effect === "allow") return { verdict: "allow" };
    return {
      verdict: "deny",
      reason: `规则拒绝：${winner.tool}(${winner.pattern})（来源：${source}）`,
    };
  }
  return { verdict: "abstain" };
}

/** 永久放行写入的规则文本：精确整串、不泛化（spec F23）。 */
export function ruleTextFor(tool: Tool, args: Record<string, unknown>): string {
  const subject = subjectFor(tool.name, args);
  return subject === undefined ? `${tool.name}()` : `${tool.name}(${subject})`;
}
