import { formatHelp, formatMemory, formatPermission, formatSession, formatStatus } from "../format.js";
import type { CommandDef } from "../types.js";

/** 只读查询命令：本地执行、不改状态、运行中可用（spec F12）。 */
export const INFO_COMMANDS: CommandDef[] = [
  {
    kind: "local", name: "help", aliases: ["h"], description: "列出可用命令或查看某条命令的用法",
    usage: "/help [命令名]", argHint: "[命令名]", availableWhileBusy: true,
    run: ({ args, ui, registry }) => ui.showMessage(formatHelp(registry, args || undefined)),
  },
  {
    kind: "local", name: "status", aliases: [], description: "查看 provider、档位、Token 与 MCP 状态",
    usage: "/status", availableWhileBusy: true,
    run: ({ ui }) => ui.showMessage(formatStatus(ui.snapshot(), ui.getUsage())),
  },
  {
    kind: "local", name: "session", aliases: [], description: "查看当前会话信息",
    usage: "/session", availableWhileBusy: true,
    run: ({ ui }) => ui.showMessage(formatSession(ui.snapshot())),
  },
  {
    kind: "local", name: "memory", aliases: [], description: "列出用户级与项目级记忆",
    usage: "/memory", availableWhileBusy: true,
    run: ({ ui }) => ui.showMessage(formatMemory(ui.snapshot())),
  },
  {
    kind: "local", name: "permission", aliases: [], description: "查看当前档位与各层权限规则",
    usage: "/permission", availableWhileBusy: true,
    run: ({ ui }) => ui.showMessage(formatPermission(ui.snapshot())),
  },
];
