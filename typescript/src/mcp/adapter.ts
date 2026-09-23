// MCP 工具适配层（plan 模块 E）：把一个远端工具包装成 MewCode 的 Tool 接口。
// 权限判定、截断、脱敏由 runTool 管线统一处理，这里只负责协议转换（spec F7、F14）。

import { fail, ok, type JSONSchemaObject, type JSONSchemaProperty, type Tool, type ToolResult } from "../tools/types.js";
import type { McpClient } from "./client.js";
import type { McpToolDef } from "./types.js";

/**
 * 把 Server 给的 inputSchema 归一化为 MewCode 的 JSONSchemaObject（plan D6）。
 * 缺 type: "object" 补上；properties/required 缺省补空；结构非法时兜底为空 schema。
 */
export function normalizeSchema(raw: Record<string, unknown> | undefined): JSONSchemaObject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {}, required: [] };
  }
  const record = raw as Record<string, unknown>;
  const properties: Record<string, JSONSchemaProperty> = {};
  if (record.properties !== undefined && record.properties !== null && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const [name, value] of Object.entries(record.properties as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const property = value as Record<string, unknown>;
      // MewCode 的参数校验只认这七种 type；Server 给的其他形态保留原 type 值，
      // 校验时会按「类型应为 X」失败——语义安全（不会误放行）。
      properties[name] = {
        type: (typeof property.type === "string" ? property.type : "string") as JSONSchemaProperty["type"],
        description: typeof property.description === "string" ? property.description : "",
        ...(Array.isArray(property.enum) ? { enum: property.enum.filter((item): item is string => typeof item === "string") } : {}),
      };
    }
  }
  const required = Array.isArray(record.required)
    ? record.required.filter((item): item is string => typeof item === "string")
    : [];
  return { type: "object", properties, required };
}

/** 把 content 数组转成回灌文本：text 块按序拼接，非 text 块记占位符（spec F14）。 */
export function contentToText(content: Array<{ type: string; text?: string }>): string {
  const parts = content.map((block) =>
    block.type === "text" ? (block.text ?? "") : `[非文本内容块: ${block.type}]`,
  );
  return parts.join("\n").trim();
}

export function createMcpTool(serverName: string, client: McpClient, def: McpToolDef): Tool {
  const description = `[MCP: ${serverName}] ${def.description ?? def.name}`;
  const parameters = normalizeSchema(def.inputSchema);

  async function execute(args: Record<string, unknown>): Promise<ToolResult> {
    // 断开/超时/协议错误的 reject 交给 runTool 统一转 exec_failed（AbortError 穿透语义保留）。
    const result = await client.callTool(def.name, args);
    const text = contentToText(result.content);
    if (result.isError) {
      return fail("exec_failed", `工具执行出错：${text || "（无错误详情）"}`);
    }
    return ok(text, text.slice(0, 120));
  }

  return {
    name: def.name,
    description,
    parameters,
    readOnly: false, // MCP 工具一律按命令执行类处理（spec F7）
    callSummary(args) {
      return `Mcp(${serverName}.${def.name})`;
    },
    execute,
  };
}
