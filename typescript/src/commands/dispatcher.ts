import { parseInput } from "./parser.js";
import type { CommandRegistry } from "./registry.js";
import type { CommandUI, DispatchResult, PromptCommand } from "./types.js";

/** 提示词类展开（spec F5）：模板固定，有参数时末尾追加「argLabel：参数」。 */
export function expandPrompt(def: PromptCommand, args: string): string {
  if (!args) return def.template;
  return `${def.template}\n\n${def.argLabel ? `${def.argLabel}：${args}` : args}`;
}

/**
 * 回车分流（spec F3–F7、N4）：非命令交回调用方送 Agent；命令在本地执行，
 * 执行异常一律转成错误消息，不向界面层抛出。
 */
export function dispatch(raw: string, deps: { registry: CommandRegistry; ui: CommandUI; busy: boolean }): DispatchResult {
  const { registry, ui, busy } = deps;
  const parsed = parseInput(raw);
  if (parsed.type === "empty") return "done";
  if (parsed.type === "text") return "not-command";

  const def = registry.resolve(parsed.name);
  if (!def) {
    ui.showMessage(`未知命令：/${parsed.name}，输入 /help 查看可用命令`, true);
    return "done";
  }
  if (busy && !def.availableWhileBusy) {
    ui.showMessage("Agent 运行中，请稍后或按 Esc 中断");
    return "rejected";
  }
  if (parsed.args && !def.argHint) {
    ui.showMessage(`用法：${def.usage}`, true);
    return "done";
  }
  if (def.kind === "prompt") {
    return ui.sendUserMessage(raw.trim(), expandPrompt(def, parsed.args)) ? "done" : "rejected";
  }

  const report = (error: unknown) => {
    ui.showMessage(`命令 /${def.name} 执行失败：${error instanceof Error ? error.message : String(error)}`, true);
  };
  try {
    const result = def.run({ args: parsed.args, ui, registry });
    if (result) result.catch(report);
  } catch (error) {
    report(error);
  }
  return "done";
}
