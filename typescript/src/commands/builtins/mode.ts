import type { PermissionMode } from "../../permission/types.js";
import type { CommandDef } from "../types.js";

function modeCommand(name: string, mode: PermissionMode, description: string): CommandDef {
  return {
    kind: "ui", name, aliases: [], description, usage: `/${name}`, availableWhileBusy: true,
    run: ({ ui }) => {
      ui.setPermissionMode(mode);
      ui.refreshStatus();
    },
  };
}

/** 档位切换（spec F12）：与 Shift+Tab 同一入口，运行中立即生效。 */
export const MODE_COMMANDS: CommandDef[] = [
  modeCommand("plan", "plan", "进入计划模式：先出计划，改动逐次确认"),
  modeCommand("do", "default", "回到执行模式（默认档）"),
  modeCommand("accept-edits", "acceptEdits", "切到接受编辑档：改文件自动放行"),
  modeCommand("bypass", "bypass", "切到放行档：工具调用不再询问"),
];
