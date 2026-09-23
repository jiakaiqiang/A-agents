import type { ProviderProtocol } from "../config/config.js";
import type { Tool } from "./types.js";

export type ToolDefinition = Record<string, unknown>;

export interface DefinitionOptions {
  /** 只导出无副作用的工具，用于计划模式。 */
  readOnlyOnly?: boolean;
}

/**
 * 延迟工具条目（spec LF1）：注册期只登记元信息，不进入工具列表。
 * loader 由装配层（manager）注入，产出完整 Tool。
 */
export interface RegistryLazyEntry {
  name: string;
  description: string;
  loader: () => Promise<Tool>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly lazy = new Map<string, RegistryLazyEntry>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具已注册：${tool.name}`);
    }
    if (this.lazy.has(tool.name)) {
      throw new Error(`延迟工具已登记：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /**
   * 登记延迟工具（spec LF1）：只占目录一行，不进入 definitionsFor 输出。
   * 与已注册工具重名视为登记冲突，抛错由调用方前置避免。
   */
  registerLazy(entry: RegistryLazyEntry): this {
    if (this.tools.has(entry.name)) {
      throw new Error(`工具已注册，无法登记延迟条目：${entry.name}`);
    }
    if (this.lazy.has(entry.name)) {
      throw new Error(`延迟工具已登记：${entry.name}`);
    }
    this.lazy.set(entry.name, entry);
    return this;
  }

  /**
   * 发现延迟工具（spec LF2b/LF5）：执行 loader 并转入 active 集合。
   * 失败时懒池条目保留、registry 不残留半成品（LN5）。
   */
  async discover(name: string): Promise<Tool | undefined> {
    const entry = this.lazy.get(name);
    if (!entry) return undefined;
    const tool = await entry.loader();
    this.lazy.delete(name);
    this.tools.set(tool.name, tool);
    return tool;
  }

  /** 未发现的延迟条目名（目录 reminder 与候选匹配用）。 */
  lazyNames(): string[] {
    return [...this.lazy.keys()];
  }

  /** 按名字取未发现延迟条目（toolSearch 与安全网共用）。 */
  getLazy(name: string): RegistryLazyEntry | undefined {
    return this.lazy.get(name);
  }

  get lazySize(): number {
    return this.lazy.size;
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
