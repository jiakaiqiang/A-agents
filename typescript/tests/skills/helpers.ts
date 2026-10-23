import type { Message } from "../../src/conversation/conversation.js";
import type { LLMClient, StreamOptions } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.js";
import type { SkillDef } from "../../src/skills/types.js";

export interface RecordedRequest {
  messages: Message[];
  tools: string[];
  pinned?: string;
  reminders: string[];
}

export function end(): StreamEvent {
  return { type: "stream_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
}

export function text(value: string): StreamEvent[] {
  return [{ type: "text_delta", text: value }, end()];
}

export function call(id: string, name: string, args: Record<string, unknown> = {}): StreamEvent[] {
  return [{ type: "tool_call_complete", toolId: id, toolName: name, arguments: args }, end()];
}

/** 按脚本逐次响应并记录每次请求；脚本用尽后回退为纯文本，避免意外死循环。 */
export function recordingClient(scripts: StreamEvent[][], hooks: { beforeEach?: (index: number, signal?: AbortSignal) => Promise<void> } = {}) {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const client: LLMClient = {
    async *stream(conversation, tools, options: StreamOptions = {}) {
      requests.push({
        messages: conversation.getMessages(),
        tools: tools.map((tool) => String((tool as { name?: string; function?: { name: string } }).name ?? (tool as { function: { name: string } }).function.name)),
        pinned: options.pinned,
        reminders: options.reminders ?? [],
      });
      const current = index++;
      await hooks.beforeEach?.(current, options.signal);
      for (const event of scripts[current] ?? text("收尾")) yield event;
    },
  };
  return { client, requests };
}

/** 构造一个 Skill 定义；正文带唯一标记，便于断言它是否出现在请求里。 */
export function makeSkill(name: string, overrides: Partial<SkillDef> = {}): SkillDef {
  return {
    name,
    description: `${name} 说明`,
    tools: null,
    mode: "shared",
    history: 0,
    body: `SOP_${name.toUpperCase()}：$ARGUMENTS`,
    source: "builtin",
    path: `/builtin/${name}.md`,
    ...overrides,
  };
}
