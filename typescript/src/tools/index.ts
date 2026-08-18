import { BashTool } from "./bash.js";
import { EditTool } from "./edit.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
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

/** 创建本期固定的六工具注册表。 */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(ReadTool)
    .register(WriteTool)
    .register(EditTool)
    .register(BashTool)
    .register(GlobTool)
    .register(GrepTool);
}
