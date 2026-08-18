import type { ProviderProtocol } from "../config/config.js";
import type { ConversationManager, ThinkingBlock, ToolUseBlock } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import type { StreamEvent, UsageInfo } from "../llm/events.js";
import { emptyUsage } from "../llm/events.js";
import { runTool } from "../tools/execute.js";
import { fail, type ToolContext, type ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface TurnCallbacks {
  onText(delta: string): void;
  onThinking(delta: string): void;
  onToolStart(id: string, name: string, argSummary: string): void;
  onToolEnd(id: string, result: ToolResult): void;
  onNotice(text: string, isError: boolean): void;
  onUsage(usage: UsageInfo): void;
  onPhase(phase: "first" | "tool" | "final"): void;
}

export interface TurnOptions {
  client: LLMClient;
  conversation: ConversationManager;
  registry: ToolRegistry;
  protocol: ProviderProtocol;
  workDir: string;
  signal?: AbortSignal;
  callbacks: TurnCallbacks;
}

export interface TurnOutcome {
  requestCount: number;
  toolsExecuted: number;
  finalText: string;
  aborted: boolean;
}

interface CollectedResponse {
  text: string;
  thinkingBlocks: ThinkingBlock[];
  toolUses: Array<ToolUseBlock & { parseError?: string }>;
  usage: UsageInfo;
  stopReason: string;
  aborted: boolean;
}

function addUsage(target: UsageInfo, current: UsageInfo): void {
  target.inputTokens += current.inputTokens;
  target.outputTokens += current.outputTokens;
  target.cacheReadInputTokens += current.cacheReadInputTokens;
  target.cacheCreationInputTokens += current.cacheCreationInputTokens;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function collectStream(
  client: LLMClient,
  conversation: ConversationManager,
  tools: Record<string, unknown>[],
  signal: AbortSignal | undefined,
  callbacks: TurnCallbacks,
): Promise<CollectedResponse> {
  let text = "";
  const thinkingBlocks: ThinkingBlock[] = [];
  const toolUses: CollectedResponse["toolUses"] = [];
  const pendingThinking = new Map<number, ThinkingBlock>();
  const usage = emptyUsage();
  let stopReason = "end_turn";

  try {
    for await (const event of client.stream(conversation, tools, signal)) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          callbacks.onText(event.text);
          break;
        case "thinking_delta":
          callbacks.onThinking(event.text);
          break;
        case "thinking_complete":
          thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
          break;
        case "tool_call_start":
          pendingThinking.set(-1, { thinking: "", signature: "" });
          break;
        case "tool_call_complete":
          toolUses.push({
            id: event.toolId,
            name: event.toolName,
            arguments: event.arguments,
            ...(event.parseError ? { parseError: event.parseError } : {}),
          });
          break;
        case "tool_call_delta":
          break;
        case "stream_end":
          stopReason = event.stopReason;
          addUsage(usage, event.usage);
          callbacks.onUsage(usage);
          break;
      }
    }
  } catch (error) {
    if (!isAbort(error)) throw error;
    pendingThinking.clear();
    return { text, thinkingBlocks, toolUses, usage, stopReason, aborted: true };
  }

  // 某些客户端不会单独产出 thinking_complete；这里不填充空 thinking，避免污染历史。
  pendingThinking.clear();
  return { text, thinkingBlocks, toolUses, usage, stopReason, aborted: false };
}

function unsupportedResult(name: string): ToolResult {
  return fail("unsupported", `本期每轮仅支持一个工具调用；工具 ${name} 未执行`);
}

function parseErrorResult(name: string, message: string): ToolResult {
  return fail("invalid_params", `工具 ${name} 的参数 JSON 无法解析：${message}`);
}

export async function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  const { client, conversation, registry, protocol, workDir, signal, callbacks } = options;
  const accumulatedUsage = emptyUsage();
  let requestCount = 0;
  let toolsExecuted = 0;
  let finalText = "";

  try {
    callbacks.onPhase("first");
    requestCount += 1;
    const first = await collectStream(
      client,
      conversation,
      registry.definitionsFor(protocol),
      signal,
      callbacks,
    );
    addUsage(accumulatedUsage, first.usage);

    if (first.aborted) {
      finalText = first.text;
      if (first.toolUses.length > 0) {
        const historyTools: ToolUseBlock[] = first.toolUses.map(({ parseError: _parseError, ...tool }) => tool);
        conversation.addAssistantFull(first.text, first.thinkingBlocks, historyTools);
        conversation.addToolResultMessage(first.toolUses.map((toolUse) => ({
          toolUseId: toolUse.id,
          content: fail("unsupported", "工具调用在执行前被中断").content,
          isError: true,
        })));
      } else if (finalText) {
        conversation.addAssistantMessage(finalText);
      }
      callbacks.onNotice("本轮已中断", true);
      callbacks.onUsage(accumulatedUsage);
      return { requestCount, toolsExecuted, finalText, aborted: true };
    }

    if (first.toolUses.length === 0) {
      finalText = first.text;
      if (finalText) conversation.addAssistantMessage(finalText);
      callbacks.onUsage(accumulatedUsage);
      return { requestCount, toolsExecuted, finalText, aborted: false };
    }

    const historyTools: ToolUseBlock[] = first.toolUses.map(({ parseError: _parseError, ...tool }) => tool);
    conversation.addAssistantFull(first.text, first.thinkingBlocks, historyTools);

    callbacks.onPhase("tool");
    const toolResults: Array<{ toolUseId: string; content: string; isError?: boolean }> = [];
    const context: ToolContext = { workDir, signal };

    for (const [index, toolUse] of first.toolUses.entries()) {
      let result: ToolResult;
      const tool = registry.get(toolUse.name);
      const summary = tool
        ? tool.callSummary(toolUse.arguments)
        : `${toolUse.name}(...)`;
      callbacks.onToolStart(toolUse.id, toolUse.name, summary);

      if (index > 0) {
        result = unsupportedResult(toolUse.name);
        callbacks.onNotice(`已跳过工具 ${toolUse.name}：本期每轮仅执行一个工具`, false);
      } else if (toolUse.parseError) {
        result = parseErrorResult(toolUse.name, toolUse.parseError);
      } else {
        result = await runTool(registry, toolUse.name, toolUse.arguments, context);
        toolsExecuted += 1;
      }

      callbacks.onToolEnd(toolUse.id, result);
      toolResults.push({ toolUseId: toolUse.id, content: result.content, isError: !result.ok });
    }

    conversation.addToolResultMessage(toolResults);

    callbacks.onPhase("final");
    requestCount += 1;
    const final = await collectStream(client, conversation, [], signal, callbacks);
    addUsage(accumulatedUsage, final.usage);
    finalText = final.text;

    if (final.aborted) {
      if (finalText) conversation.addAssistantMessage(finalText);
      callbacks.onNotice("本轮已中断", true);
      callbacks.onUsage(accumulatedUsage);
      return { requestCount, toolsExecuted, finalText, aborted: true };
    }

    if (final.toolUses.length > 0) {
      callbacks.onNotice("最终续答阶段不支持工具调用，本轮已结束", true);
    }
    if (finalText) conversation.addAssistantMessage(finalText);
    callbacks.onUsage(accumulatedUsage);
    return { requestCount, toolsExecuted, finalText, aborted: false };
  } catch (error) {
    if (!isAbort(error)) throw error;
    if (finalText) conversation.addAssistantMessage(finalText);
    callbacks.onNotice("本轮已中断", true);
    callbacks.onUsage(accumulatedUsage);
    return { requestCount, toolsExecuted, finalText, aborted: true };
  }
}
