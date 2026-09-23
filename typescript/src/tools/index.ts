import { BashTool } from "./bash.js";
import { EditTool } from "./edit.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { createToolSearchTool } from "../mcp/tool-search.js";
import { ReadTool } from "./read.js";
import { ToolRegistry } from "./registry.js";
import { WriteTool } from "./write.js";

export { runTool } from "./execute.js";
export { ToolRegistry } from "./registry.js";
export type {
  JSONSchemaObject,
  JSONSchemaProperty,
  Tool,
  ToolContext,
  ToolErrorKind,
  ToolResult,
} from "./types.js";

/**
 * 创建内置工具注册表，并挂载 toolSearch 元工具（spec LF7）。
 * module 依赖无环：tool-search.ts 只 import 本模块的类型与 registry 类型。
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
    .register(ReadTool)
    .register(WriteTool)
    .register(EditTool)
    .register(BashTool)
    .register(GlobTool)
    .register(GrepTool);
  return registry.register(createToolSearchTool(registry));
}
