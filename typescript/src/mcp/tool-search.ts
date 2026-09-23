// toolSearch 元工具（spec LF2）：模型按目录选定工具后拉取完整定义。
// 三分支：已加载 / 命中发现 / 模糊候选。readOnly，走既有 runTool 管线。

import type { ToolRegistry } from "../tools/registry.js";
import { ok, type Tool, type ToolContext, type ToolResult } from "../tools/types.js";

/** 参数 schema 的紧凑文本形态（回灌给模型按此重发，LF2b/LF5b）。 */
function schemaToText(tool: Tool): string {
  const parameters = tool.parameters;
  const props = Object.entries(parameters.properties)
    .map(([key, prop]) => {
      const required = parameters.required.includes(key) ? "必填" : "可选";
      const enums = prop.enum ? `，枚举：${prop.enum.join(" | ")}` : "";
      return `  - ${key}（${prop.type}，${required}）：${prop.description}${enums}`;
    })
    .join("\n");
  return [
    `工具名：${tool.name}`,
    `说明：${tool.description}`,
    `参数：`,
    props || "  （无参数）",
  ].join("\n");
}

/** 包含匹配：名字或描述里含 query 片段即候选（大小写不敏感，LF2c）。 */
function candidates(registry: ToolRegistry, query: string): string[] {
  const lowered = query.toLowerCase();
  const lazyCandidates = registry.lazyNames()
    .filter((name) => name.toLowerCase().includes(lowered) || (registry.getLazy(name)?.description ?? "").toLowerCase().includes(lowered));
  const activeCandidates = registry.list()
    .filter((tool) => tool.name.toLowerCase().includes(lowered))
    .map((tool) => tool.name);
  return [...new Set([...lazyCandidates, ...activeCandidates])];
}

export function createToolSearchTool(registry: ToolRegistry): Tool {
  return {
    name: "toolSearch",
    description:
      "查找并加载延迟工具。传入工具名（来自延迟工具目录），返回其完整定义（参数 schema）。" +
      "加载成功后，下一轮即可直接调用该工具。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "工具名或关键词" },
      },
      required: ["query"],
    },
    readOnly: true,
    callSummary(args) {
      return `toolSearch(${String(args.query ?? "")})`;
    },
    async execute(args, _context: ToolContext): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return ok("query 不能为空。传入工具名或关键词，例如 toolSearch({\"query\": \"mcp_search_web\"})。", "toolSearch(空)");
      }

      // a) 已注册：直接返回定义，不重复发现（LF2a/LA3）。
      const active = registry.get(query);
      if (active) {
        return ok(
          `${schemaToText(active)}\n\n该工具已加载，可直接调用。`,
          `toolSearch(${query} 已加载)`,
        );
      }

      // b) 命中懒池：发现并返回完整定义（LF2b/LA2）。
      const lazyEntry = registry.getLazy(query);
      if (lazyEntry) {
        try {
          const tool = await registry.discover(query);
          if (tool) {
            return ok(
              `${schemaToText(tool)}\n\n已加载，下一轮可直接调用。`,
              `toolSearch(${query} 已加载)`,
            );
          }
        } catch (error) {
          // loader 失败：懒池条目保留可重试（LN5）。
          const message = error instanceof Error ? error.message : String(error);
          return ok(`加载 ${query} 失败：${message}。条目仍在延迟目录中，可稍后重试。`, `toolSearch(${query} 失败)`);
        }
      }

      // c) 未命中：返回候选列表（LF2c/LA4）。
      const matched = candidates(registry, query);
      if (matched.length === 0) {
        return ok(
          `未找到与 "${query}" 匹配的工具。当前延迟目录与已加载工具中均无此名字。`,
          `toolSearch(${query} 未找到)`,
        );
      }
      const listing = matched
        .map((name) => {
          const lazy = registry.getLazy(name);
          return lazy ? `- ${name}（未加载）：${lazy.description}` : `- ${name}（已加载）`;
        })
        .join("\n");
      return ok(
        `"${query}" 未精确命中。相近候选：\n${listing}\n\n用精确名字再次调用 toolSearch 即可加载。`,
        `toolSearch(${query} 候选 ${matched.length} 个)`,
      );
    },
  };
}
