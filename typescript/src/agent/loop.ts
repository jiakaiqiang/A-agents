import type { ProviderProtocol } from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import type { UsageInfo } from "../llm/events.js";
import { emptyUsage } from "../llm/events.js";
import { MAX_INVALID_ITERATIONS, MAX_ITERATIONS } from "../tools/limits.js";
import type { PermissionGate } from "../permission/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { fail } from "../tools/types.js";
import { planBatches, runBatches } from "./batch.js";
import { collectStream, isAbort } from "./collect.js";
import type { AgentEvent, AgentMode, StopReason } from "./events.js";

export interface LoopOptions {
  client: LLMClient;
  conversation: ConversationManager;
  registry: ToolRegistry;
  protocol: ProviderProtocol;
  workDir: string;
  mode: AgentMode;
  /** 权限档位、规则与确认回调，原样透传给工具上下文（权限 spec F1）。 */
  permission?: PermissionGate;
  signal?: AbortSignal;
  /** 本轮挂在每次模型请求上的补充指令，只影响这一轮，不写入会话历史（spec F16）。 */
  reminders?: string[];
  maxIterations?: number; // 缺省取 MAX_ITERATIONS，测试可覆盖
}

function addUsage(target: UsageInfo, current: UsageInfo): void {
  target.inputTokens += current.inputTokens;
  target.outputTokens += current.outputTokens;
  target.cacheReadInputTokens += current.cacheReadInputTokens;
  target.cacheCreationInputTokens += current.cacheCreationInputTokens;
}

/** 写入历史的收尾说明：保证非自然停止时历史末尾是助手消息（spec F4）。 */
function closingText(reason: StopReason, iterations: number): string {
  switch (reason) {
    case "max_iterations":
      return `（已达到本轮迭代上限 ${iterations} 轮，任务可能未完成）`;
    case "cancelled":
      return "（本轮已被用户中断）";
    case "invalid_tools":
      return "（模型连续请求不存在的工具，本轮已中止）";
    case "stream_error":
      return "（本轮因请求错误中止）";
    default:
      return "";
  }
}

/** 界面提示文案，与写入历史的收尾说明分开措辞（spec F30）。 */
function noticeText(reason: StopReason, iterations: number): string {
  switch (reason) {
    case "max_iterations":
      return `已达到迭代上限（${iterations} 轮），本轮中止；可继续输入让它接着做。`;
    case "cancelled":
      return "本轮已中断。";
    case "invalid_tools":
      return `模型连续 ${MAX_INVALID_ITERATIONS} 轮请求不存在的工具，本轮已中止。`;
    case "stream_error":
      return "本轮因请求错误中止。";
    default:
      return "";
  }
}

/**
 * ReAct 循环（spec F1–F10）：一轮内反复「调模型 → 执行工具 → 结果回写」，
 * 直到模型不再请求工具或命中某个停止条件。事件流是唯一对外输出，不引用界面模块。
 */
export async function* runLoop(options: LoopOptions): AsyncGenerator<AgentEvent> {
  const { client, conversation, registry, protocol, workDir, mode, permission, signal } = options;
  const reminders = options.reminders ?? [];
  const limit = options.maxIterations ?? MAX_ITERATIONS;

  let iterations = 0;
  let toolsExecuted = 0;
  let invalidStreak = 0;
  let finalText = "";
  const accumulated = emptyUsage();
  // 末次写入是否为工具结果消息，决定停止时是否需要补收尾助手消息。
  let lastWriteWasToolResult = false;

  function* finish(reason: StopReason, errorMessage?: string): Generator<AgentEvent> {
    if (reason !== "complete" && lastWriteWasToolResult) {
      // 工具结果在协议层映射为 user 消息，不补助手消息会让下一轮出现连续两条 user。
      conversation.addAssistantMessage(closingText(reason, iterations));
    }
    if (reason !== "complete") {
      yield { type: "notice", text: noticeText(reason, iterations), isError: reason !== "cancelled" };
    }
    yield {
      type: "done",
      reason,
      iterations,
      toolsExecuted,
      finalText,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  try {
    while (iterations < limit) {
      if (signal?.aborted) return yield* finish("cancelled");

      iterations += 1;
      yield { type: "progress", iteration: iterations, phase: "model", toolsExecuted };

      // 全部工具都下发：计划档对改文件的约束改由权限层逐次确认承担，不再靠摘掉工具（权限 spec F19）。
      const tools = registry.definitionsFor(protocol);
      //进行流相应；补充指令每次迭代都挂，否则工具结果回灌后模式约束就断了
      const response = yield* collectStream(client, conversation, tools, { signal, reminders });
      addUsage(accumulated, response.usage);
      yield { type: "usage", usage: { ...accumulated } };
      finalText = response.text;
      //工具调用为空，说明模型不再请求工具，本轮自然完成（F5）。
      if (response.toolUses.length === 0) {
        if (finalText) conversation.addAssistantMessage(finalText);
        lastWriteWasToolResult = false;
        return yield* finish(response.aborted ? "cancelled" : "complete");
      }

      // parseError 只用于本轮判断，不写进历史。
      const historyTools = response.toolUses.map(({ parseError: _parseError, ...rest }) => rest);
      conversation.addAssistantFull(response.text, response.thinkingBlocks, historyTools);

      if (response.aborted) {
        // 流在产出工具调用后被中断：调用未执行，全部回灌 cancelled 保持配对（F3/F22）。
        conversation.addToolResultMessage(response.toolUses.map((call) => {
          const result = fail("cancelled", `本轮已中断，工具 ${call.name} 未执行`);
          return { toolUseId: call.id, content: result.content, isError: true };
        }));
        lastWriteWasToolResult = true;
        return yield* finish("cancelled");
      }

      yield { type: "progress", iteration: iterations, phase: "tools", toolsExecuted };

      const batches = planBatches(response.toolUses, registry);
      // runBatches 对每个调用都产出一条结果，results 与 toolUses 长度必然相等（F3）。
      const results = yield* runBatches(batches, registry, { workDir, signal, permission });
      toolsExecuted += results.filter((item) => !item.isError).length;
      conversation.addToolResultMessage(results);
      lastWriteWasToolResult = true;

      // 全部调用都指向未知工具才算无效迭代；混合情况说明模型仍在推进任务（F8）。
      const allUnknown = response.toolUses.every((call) => !registry.get(call.name));
      invalidStreak = allUnknown ? invalidStreak + 1 : 0;
      if (invalidStreak >= MAX_INVALID_ITERATIONS) return yield* finish("invalid_tools");

      if (signal?.aborted) return yield* finish("cancelled");
    }

    return yield* finish("max_iterations");
  } catch (error) {
    if (isAbort(error)) return yield* finish("cancelled");
    return yield* finish("stream_error", error instanceof Error ? error.message : String(error));
  }
}
