import type { CommandDef } from "../types.js";

/** 会话级界面命令（spec F12）：清空与压缩改动历史，运行中不可用；恢复与退出沿用原行为。 */
export const SESSION_COMMANDS: CommandDef[] = [
  {
    kind: "ui", name: "clear", aliases: [], description: "清空对话并开始新会话（旧会话可 /resume 找回）",
    usage: "/clear", availableWhileBusy: false,
    run: ({ ui }) => ui.clearConversation(),
  },
  {
    kind: "ui", name: "compact", aliases: [], description: "立即压缩上下文",
    usage: "/compact", availableWhileBusy: false,
    run: ({ ui }) => ui.compact(),
  },
  {
    kind: "ui", name: "resume", aliases: [], description: "恢复历史会话",
    usage: "/resume", availableWhileBusy: true,
    run: ({ ui }) => ui.openResume(),
  },
  {
    kind: "ui", name: "exit", aliases: ["quit", "q"], description: "退出 MewCode",
    usage: "/exit", availableWhileBusy: true,
    run: ({ ui }) => ui.exit(),
  },
];
