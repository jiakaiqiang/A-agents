import type { AgentEvent, AgentMode } from "../agent/events.js";
import { runLoop, type SkillView } from "../agent/loop.js";
import type { ProviderProtocol } from "../config/config.js";
import { ConversationManager, type Message } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import type { PermissionGate } from "../permission/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { LOAD_SKILL_TOOL } from "./manager.js";
import { expandBody } from "./parser.js";
import type { IsolatedOutcome, SkillDef } from "./types.js";

/**
 * 截取主历史最近 n 条带进子对话（spec F11）：不拆开工具调用与其结果，必要时少取。
 * 末尾带工具调用却还没有结果的助手消息（比如正在执行的 loadSkill）一并丢掉。
 */
export function recentHistory(messages: Message[], n: number): Message[] {
  if (n <= 0) return [];
  const usable = messages.filter((message) => message.role !== "system");
  while (usable.length && usable.at(-1)!.role === "assistant" && usable.at(-1)!.toolUses?.length) usable.pop();
  let window = usable.slice(-n);
  // 起点必须是一条普通用户消息：开头是工具结果说明它的调用被切掉了，开头是助手消息则不符合协议的轮次交替。
  const start = window.findIndex((message) => message.role === "user" && !message.toolResults?.length);
  window = start < 0 ? [] : window.slice(start);
  return structuredClone(window);
}

/** 子对话可用工具：Skill 白名单，不写即全部；无论哪种都不含加载工具，不可嵌套（spec F11）。 */
export function isolatedToolScope(skill: SkillDef, registry: ToolRegistry): ReadonlySet<string> {
  const names = new Set(skill.tools ?? [...registry.list().map((tool) => tool.name), ...registry.lazyNames()]);
  names.delete(LOAD_SKILL_TOOL);
  return names;
}

/** 回流到主对话的结果文本（spec F11）。 */
export function resultMessage(name: string, outcome: IsolatedOutcome): string {
  return outcome.ok ? `【Skill ${name} 结果】\n${outcome.text}` : `【Skill ${name} 未完成】${outcome.text}`;
}

const STOP_TEXT: Record<string, string> = {
  cancelled: "已被用户中断",
  max_iterations: "达到迭代上限，任务可能未完成",
  invalid_tools: "模型连续请求不可用的工具，已中止",
  stream_error: "模型请求失败",
};

/**
 * 独立子对话（spec F11）：新建一个不挂记录器的会话（不进主历史、不进存档），跑完整的 Agent 循环。
 * 不传 Compactor 与模式 reminder：子任务预期短，计划档约束仍由权限层逐次确认承担（plan「技术决策」）。
 * done 之外的事件原样交给调用方渲染；最后一条回复即摘要。
 */
export async function* runIsolatedSkill(options: {
  skill: SkillDef;
  args: string;
  history: Message[];
  client: LLMClient;
  registry: ToolRegistry;
  protocol: ProviderProtocol;
  workDir: string;
  mode: AgentMode;
  permission?: PermissionGate;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent, IsolatedOutcome> {
  const { skill } = options;
  const conversation = new ConversationManager();
  conversation.restore(recentHistory(options.history, skill.history));
  conversation.addUserMessage(expandBody(skill.body, options.args));
  const scope = isolatedToolScope(skill, options.registry);
  const view: SkillView = { pinnedText: () => "", allowedTools: () => scope };

  try {
    for await (const event of runLoop({
      client: options.client,
      conversation,
      registry: options.registry,
      protocol: options.protocol,
      workDir: options.workDir,
      mode: options.mode,
      permission: options.permission,
      signal: options.signal,
      skills: view,
    })) {
      if (event.type !== "done") {
        yield event;
        continue;
      }
      if (event.reason === "complete") {
        return event.finalText.trim()
          ? { ok: true, text: event.finalText.trim() }
          : { ok: false, text: "子对话没有给出回复" };
      }
      const reason = STOP_TEXT[event.reason] ?? event.reason;
      return { ok: false, text: event.errorMessage ? `${reason}：${event.errorMessage}` : reason };
    }
    return { ok: false, text: "子对话异常结束" };
  } catch (error) {
    return { ok: false, text: `子对话执行失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
