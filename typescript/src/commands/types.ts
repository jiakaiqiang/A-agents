// 斜杠命令系统的类型定义（spec F1、F8）。
// 本模块不依赖任何界面框架：命令只经 CommandUI 操作界面（spec N2）。

import type { McpServerReport } from "../mcp/types.js";
import type { NoteScope, NoteType } from "../memory/notes.js";
import type { PermissionMode, RuleSet } from "../permission/types.js";
import type { SkillMode, SkillSource } from "../skills/types.js";
import type { CommandRegistry } from "./registry.js";

/** 三类执行模式：纯本地、影响界面状态、把预设提示词送进对话（spec F5）。 */
export type CommandKind = "local" | "ui" | "prompt";

interface BaseCommand {
  name: string; // 主名，不带斜杠，小写
  aliases: string[];
  description: string;
  usage: string; // 如 "/help [命令名]"
  availableWhileBusy: boolean; // Agent 运行中是否可执行（spec F6）
  argHint?: string; // 如 "[命令名]"；有它才接受参数（spec F7）
  hidden?: boolean; // 不出现在 /help 与补全里
}

/** 本地类与界面类：必须有执行逻辑。 */
export interface RunCommand extends BaseCommand {
  kind: "local" | "ui";
  run(ctx: CommandContext): void | Promise<void>;
}

/** 提示词类：固定模板，有参数时末尾追加「argLabel：参数」。 */
export interface PromptCommand extends BaseCommand {
  kind: "prompt";
  template: string;
  argLabel?: string;
}

export type CommandDef = RunCommand | PromptCommand;

export interface CommandContext {
  args: string;
  ui: CommandUI;
  registry: CommandRegistry; // /help 要列命令
}

export type ParsedInput =
  | { type: "empty" }
  | { type: "text"; text: string }
  | { type: "command"; name: string; args: string };

/** 分发结果：not-command 交回调用方送 Agent；done 清空输入；rejected 保留输入。 */
export type DispatchResult = "not-command" | "done" | "rejected";

export interface Suggestion {
  name: string;
  description: string;
}

/** 界面控制接口（spec F8）：命令实现只依赖它，不碰渲染框架。 */
export interface CommandUI {
  showMessage(text: string, isError?: boolean): void;
  /** 对话区显示 display，模型收到 prompt；客户端未就绪返回 false。 */
  sendUserMessage(display: string, prompt: string): boolean;
  setPermissionMode(mode: PermissionMode): void;
  getUsage(): UsageSnapshot;
  refreshStatus(): void;
  clearConversation(): void;
  compact(): Promise<void>;
  openResume(): void;
  exit(): void;
  snapshot(): StatusSnapshot;
  /** 全部可用 Skill 及激活状态（Skill spec F12）。 */
  listSkills(): SkillListItem[];
  /** 停用一个或全部（不传名字）已激活 Skill，返回实际停用的名字（Skill spec F12）。 */
  deactivateSkills(name?: string): string[];
  /** 调用 Skill：共享模式钉住后发起一轮，独立模式跑子对话；客户端未就绪返回 false（Skill spec F9、F11）。 */
  invokeSkill(name: string, args: string, display: string): boolean;
}

export interface SkillListItem {
  name: string;
  description: string;
  mode: SkillMode;
  source: SkillSource;
  active: boolean;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  usedTokens: number | null; // Compactor 未就绪时为 null
}

export interface StatusSnapshot {
  provider: { name: string; protocol: string; model: string; baseUrl: string }; // 不含 api_key（spec N5）
  permissionMode: PermissionMode;
  rules: RuleSet;
  session: { id: string; messageCount: number; path: string };
  memory: Record<NoteScope, Array<{ name: string; type: NoteType; description: string }>>;
  mcp: McpServerReport[];
}
