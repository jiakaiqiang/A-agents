import { decide } from "../permission/decide.js";
import { redact } from "./redact.js";
import { validate } from "./schema.js";
import { SUMMARY_MAX_CHARS, TOOL_RESULT_MAX_CHARS } from "./limits.js";
import { fail, type ToolContext, type ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";

function truncateContent(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
  const marker = `\n[truncated: kept ${TOOL_RESULT_MAX_CHARS} of ${content.length} chars]`;
  return `${content.slice(0, Math.max(0, TOOL_RESULT_MAX_CHARS - marker.length))}${marker}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function truncateSummary(summary: string): string {
  const value = oneLine(summary);
  return value.length <= SUMMARY_MAX_CHARS ? value : `${value.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** 工具调用唯一入口：查找、校验、权限判定、执行、脱敏、截断。 */
export async function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) return fail("unknown_tool", `未知工具：${name}`);

  const validation = validate(tool.parameters, args);
  if (!validation.ok) {
    return fail("invalid_params", validation.errors.join("；"));
  }

  // 权限判定在执行之前，拒绝时工具不得产生任何副作用（权限 spec F1、N1）。
  // 用 validation.value 而非原始 args：拿到的是归一化后的参数。
  const decision = await decide(tool, validation.value, context);
  if (decision.verdict === "deny") {
    return fail("permission_denied", decision.reason);
  }

  let result: ToolResult;
  try {
    result = await tool.execute(validation.value, context);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    result = fail("exec_failed", message);
  }

  const content = redact(truncateContent(result.content));
  const summary = truncateSummary(redact(result.summary));
  return { ...result, content, summary };
}
