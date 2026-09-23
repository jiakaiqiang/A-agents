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

/** 工具调用的唯一入口：查找、（安全网补载）、校验、权限判定、执行、脱敏、截断。 */
export async function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  let tool = registry.get(name);

  // 安全网（spec LF5）：registry 未命中先查懒池自动补载——
  // 模型可能跳过 toolSearch 直接按目录名调用（训练习性），不在此拦截会白丢一轮。
  if (!tool && registry.getLazy(name)) {
    const discovered = await registry.discover(name);
    if (discovered) {
      // 参数能过 schema 校验 → 当次直接执行（LF5a/LA6）；
      // 过不了 → 走下方正常校验失败路径，错误信息附 schema（LF5b/LA7）。
      const precheck = validate(discovered.parameters, args);
      if (precheck.ok) {
        tool = discovered;
      } else {
        const props = Object.entries(discovered.parameters.properties)
          .map(([key, prop]) => `  - ${key}（${prop.type}${discovered.parameters.required.includes(key) ? "，必填" : "，可选"}）：${prop.description}`)
          .join("\n");
        return fail(
          "invalid_params",
          `工具 ${name} 已按目录自动加载，但参数不符：${precheck.errors.join("；")}\n完整定义：\n${props || "（无参数）"}\n请按上述 schema 重发调用。`,
        );
      }
    }
  }
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
