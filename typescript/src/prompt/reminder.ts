import type { AgentMode } from "../agent/events.js";
import { PLAN_REMINDER_INTERVAL } from "../tools/limits.js";

/**
 * 把补充指令包成 `<system-reminder>` 标签（spec F14）。
 * 用尖括号标签是因为训练语料里这类标签本身就是结构边界，
 * 模型会当成系统侧提示读，而不是当成用户发来的话去回应。
 */
export function wrapReminder(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

/** 计划模式首轮与间隔轮次注入的完整版指令。 */
const PLAN_FULL = `当前处于计划模式。在用户明确批准之前，不要修改任何文件，也不要执行会产生副作用的命令。

这一模式下应该做的事：
- 用读文件、搜索、列目录这类无副作用的工具把现状弄清楚
- 需求含糊的地方直接问，不要猜着往下做
- 给出可执行的方案：改哪些文件、每处改什么、怎么验证
- 方案讲完就停下等用户回应，不要顺手开始实现

改文件与执行命令的工具仍然可用，但每次调用都会请用户确认。不要靠它们绕开先出方案这一步。`;

/** 其余轮次注入的精简版，只保留边界，控制注入体积。 */
const PLAN_BRIEF = `仍在计划模式：只做调研和方案，不要改文件、不要执行有副作用的命令。`;

/**
 * 按轮次决定注入哪一版模式指令（spec F17–F19）。
 * 计数要跨轮存活，所以实例由界面层持有，不能建在每轮的 runLoop 里。
 */
export class ModeTracker {
  private mode: AgentMode = "execute";
  private turns = 0;

  /** 模式切换后计数归零，下一轮重新按首轮发完整版。 */
  setMode(mode: AgentMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.turns = 0;
  }

  /** 每轮开始时调一次，返回本轮要挂载的补充指令；执行模式下为空。 */
  nextTurn(): string[] {
    if (this.mode !== "plan") return [];
    const full = this.turns % PLAN_REMINDER_INTERVAL === 0;
    this.turns += 1;
    return [wrapReminder(full ? PLAN_FULL : PLAN_BRIEF)];
  }
}
