import { classifyTool, MODE_FALLBACK } from "./limits.js";
import { checkBlacklist } from "./blacklist.js";
import { checkSandbox } from "./sandbox.js";
import { checkRules, parseRule, ruleTextFor } from "./rules.js";
import type { ConfirmChoice, PermissionDecision, Rule } from "./types.js";
import type { Tool, ToolContext } from "../tools/types.js";

const NO_INTERACTIVE = "当前环境无法交互确认，该操作已被拒绝。";
const USER_DENIED = "用户拒绝了此操作";

/**
 * 五层判定入口（spec F1、F2）。
 * 前两层只 deny / abstain；规则层可放行；档位兜底可放行或转确认；人在回路消解 ask。
 */
export async function decide(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PermissionDecision> {
  const blacklisted = checkBlacklist(tool.name, args);
  if (blacklisted.verdict === "deny") {
    return { verdict: "deny", layer: "blacklist", reason: blacklisted.reason ?? "危险操作被拒绝" };
  }

  const sandboxed = checkSandbox(tool, args, context.workDir);
  if (sandboxed.verdict === "deny") {
    return { verdict: "deny", layer: "sandbox", reason: sandboxed.reason ?? "路径超出工作目录" };
  }

  const gate = context.permission;
  if (!gate) {
    const fallback = MODE_FALLBACK.default[classifyTool(tool)];
    if (fallback === "allow") return { verdict: "allow", layer: "mode" };
    return { verdict: "deny", layer: "mode", reason: NO_INTERACTIVE };
  }

  const ruled = checkRules(gate.rules, tool.name, args);
  if (ruled.verdict === "allow") return { verdict: "allow", layer: "rule" };
  if (ruled.verdict === "deny") {
    return { verdict: "deny", layer: "rule", reason: ruled.reason ?? "规则拒绝" };
  }

  const fallback = MODE_FALLBACK[gate.mode][classifyTool(tool)];
  if (fallback === "allow") return { verdict: "allow", layer: "mode" };

  if (!gate.confirm) {
    return { verdict: "deny", layer: "human", reason: NO_INTERACTIVE };
  }

  let choice: ConfirmChoice;
  try {
    choice = await gate.confirm({
      toolName: tool.name,
      summary: tool.callSummary(args),
      ruleCandidate: ruleTextFor(tool, args),
    });
  } catch {
    return { verdict: "deny", layer: "human", reason: NO_INTERACTIVE };
  }

  if (choice === "deny") return { verdict: "deny", layer: "human", reason: USER_DENIED };

  if (choice === "session" || choice === "always") {
    const source = choice === "always" ? "local" : "session";
    const text = ruleTextFor(tool, args);
    const granted: Rule = parseRule(text, "allow", source, gate.rules.layers[source].length) ?? {
      tool: tool.name,
      pattern: text,
      effect: "allow",
      source,
      order: gate.rules.layers[source].length,
    };
    if (choice === "session") gate.grantSession(granted);
    else gate.grantAlways(granted);
  }

  return { verdict: "allow", layer: "human" };
}
