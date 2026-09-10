import type { ConversationManager, ThinkingBlock, ToolUseBlock } from "../conversation/conversation.js";
import type { LLMClient, StreamOptions } from "../llm/client.js";
import type { UsageInfo } from "../llm/events.js";
import { emptyUsage } from "../llm/events.js";
import type { AgentEvent } from "./events.js";

export interface CollectedResponse {
  text: string;
  thinkingBlocks: ThinkingBlock[];
  toolUses: Array<ToolUseBlock & { parseError?: string }>;
  usage: UsageInfo;
  stopReason: string;
  aborted: boolean;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 双路收集器（spec F15/F16）：一次流消费同时做两件事。
 * yield 出文本与思考增量供界面实时渲染，return 出完整响应供循环判断下一步。
 */
export async function* collectStream(
  client: LLMClient,
  conversation: ConversationManager,
  tools: Record<string, unknown>[],
  options: StreamOptions = {},
): AsyncGenerator<AgentEvent, CollectedResponse> {
  let text = "";
  const thinkingBlocks: ThinkingBlock[] = [];
  const toolUses: CollectedResponse["toolUses"] = [];
  const usage = emptyUsage();
  let stopReason = "end_turn";

  try {
    for await (const event of client.stream(conversation, tools, options)) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          yield { type: "text", text: event.text };
          break;
        case "thinking_delta":
          yield { type: "thinking", text: event.text };
          break;
        case "thinking_complete":
          // 思考块只入历史供协议重放，不产生事件（界面本期不展示）。
          thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
          break;
        case "tool_call_complete":
          toolUses.push({
            id: event.toolId,
            name: event.toolName,
            arguments: event.arguments,
            ...(event.parseError ? { parseError: event.parseError } : {}),
          });
          break;
        case "tool_call_start":
        case "tool_call_delta":
          // 工具行由 runBatches 在真正执行前统一发出，此处忽略：
          // 参数还没解析完就画行会导致摘要为空。
          break;
        case "stream_end":
          stopReason = event.stopReason;
          usage.inputTokens += event.usage.inputTokens;
          usage.outputTokens += event.usage.outputTokens;
          usage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
          usage.cacheCreationInputTokens += event.usage.cacheCreationInputTokens;
          // 不在此 yield usage：界面需要的是本轮累计值，累加由 loop.ts 负责（F31）。
          break;
      }
    }
  } catch (error) {
    // 取消不是错误，转成 aborted 让循环走正常停止路径；其余错误交 loop 兜成 stream_error。
    if (!isAbort(error)) throw error;
    return { text, thinkingBlocks, toolUses, usage, stopReason, aborted: true };
  }

  return { text, thinkingBlocks, toolUses, usage, stopReason, aborted: false };
}
