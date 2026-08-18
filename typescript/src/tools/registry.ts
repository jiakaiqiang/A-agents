import type { ProviderProtocol } from "../config/config.js";
import type { Tool } from "./types.js";

export type ToolDefinition = Record<string, unknown>;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具已注册：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitionsFor(protocol: ProviderProtocol): ToolDefinition[] {
    return this.list().map((tool) => {
      if (protocol === "anthropic") {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        };
      }
      if (protocol === "openai") {
        return {
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        };
      }
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };
    });
  }
}
