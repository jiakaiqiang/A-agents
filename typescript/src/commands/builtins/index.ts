import { CommandRegistry } from "../registry.js";
import type { CommandDef } from "../types.js";
import { INFO_COMMANDS } from "./info.js";
import { MODE_COMMANDS } from "./mode.js";
import { SESSION_COMMANDS } from "./session.js";
import { SKILLS_COMMAND } from "./skills.js";

/**
 * 全部内置命令；新增命令只需在对应文件加一条定义（spec N7）。
 * /review 已由内部 review Skill 取代，Skill 命令在启动期由 bootstrapSkills 动态登记（Skill spec F5）。
 */
export const BUILTIN_COMMANDS: CommandDef[] = [...INFO_COMMANDS, ...SESSION_COMMANDS, ...MODE_COMMANDS, SKILLS_COMMAND];

/** defs 可注入，仅供测试构造冲突场景。 */
export function createBuiltinRegistry(defs: CommandDef[] = BUILTIN_COMMANDS): CommandRegistry {
  const registry = new CommandRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

/** 启动期登记：冲突直接以非零码退出，不进入界面（spec F2、N6）。 */
export function createCommandsOrExit(defs: CommandDef[] = BUILTIN_COMMANDS): CommandRegistry {
  try {
    return createBuiltinRegistry(defs);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    process.exit();
  }
}
