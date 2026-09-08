import type { ProviderProtocol } from "../config/config.js";
import type { Tool } from "./types.js";

export type ToolDefinition = Record<string, unknown>;

export interface DefinitionOptions {
  /** 只导出无副作用的工具，用于计划模式。 */
  readOnlyOnly?: boolean;
}

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

  /** 无副作用工具子集；计划模式的可用工具与并发批的成员都由此派生。 */
  listReadOnly(): Tool[] {
    return this.list().filter((tool) => tool.readOnly);
  }

  definitionsFor(protocol: ProviderProtocol, options?: DefinitionOptions): ToolDefinition[] {
    const source = options?.readOnlyOnly ? this.listReadOnly() : this.list();
    return source.map((tool) => {
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
