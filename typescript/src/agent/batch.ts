import type { ToolResultBlock } from "../conversation/conversation.js";
import { runTool } from "../tools/execute.js";
import { MAX_CONCURRENT_TOOLS } from "../tools/limits.js";
import type { ToolRegistry } from "../tools/registry.js";
import { fail, type ToolContext, type ToolResult } from "../tools/types.js";
import { isAbort } from "./collect.js";
import type { AgentEvent } from "./events.js";

export interface PendingCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  parseError?: string;
}

export interface ToolBatch {
  concurrent: boolean; // true = 批内并发；false = 单调用串行批
  calls: PendingCall[];
}

/**
 * 保序分段（spec F19）：按模型给出的原始顺序扫描，相邻的只读调用合并为一个并发批，
 * 每个有副作用的调用单独成串行批。不重排、不跨串行批合并。
 */
export function planBatches(calls: PendingCall[], registry: ToolRegistry): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const call of calls) {
    // 未知工具 get 返回 undefined，自然落到 false，归串行批（无法确认其副作用）。
    const isReadOnly = registry.get(call.name)?.readOnly === true;
    const previous = batches.at(-1);
    if (isReadOnly && previous?.concurrent) {
      previous.calls.push(call);
    } else {
      batches.push({ concurrent: isReadOnly, calls: [call] });
    }
  }
  return batches;
}

function summaryOf(registry: ToolRegistry, call: PendingCall): string {
  const tool = registry.get(call.name);
  return tool ? tool.callSummary(call.arguments) : `${call.name}(...)`;
}

async function runOne(
  registry: ToolRegistry,
  call: PendingCall,
  context: ToolContext,
): Promise<ToolResult> {
  if (call.parseError) {
    // 参数不完整时不得尝试执行（F17）。
    return fail("invalid_params", `工具 ${call.name} 的参数 JSON 无法解析：${call.parseError}`);
  }
  return runTool(registry, call.name, call.arguments, context);
}

function chunk(calls: PendingCall[], size: number): PendingCall[][] {
  const chunks: PendingCall[][] = [];
  for (let index = 0; index < calls.length; index += size) {
    chunks.push(calls.slice(index, index + size));
  }
  return chunks;
}

function cancelledResult(name: string): ToolResult {
  return fail("cancelled", `本轮已中断，工具 ${name} 未执行`);
}

function toBlock(call: PendingCall, result: ToolResult): ToolResultBlock {
  return { toolUseId: call.id, content: result.content, isError: !result.ok };
}

/**
 * 按批次顺序执行（spec F20–F22）：yield 工具事件，return 按调用原始顺序排列的结果。
 * 每个调用都必然产出一条结果，保证与助手消息中的 tool_use 严格配对。
 */
export async function* runBatches(
  batches: ToolBatch[],
  registry: ToolRegistry,
  context: ToolContext,
): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  let cancelled = context.signal?.aborted === true;

  for (const batch of batches) {
    cancelled = cancelled || context.signal?.aborted === true;

    if (cancelled) {
      // 已取消：剩余调用不执行，但仍走完整事件与结果流程，保持配对完整（F22）。
      for (const call of batch.calls) {
        yield { type: "tool_start", toolId: call.id, name: call.name, argSummary: summaryOf(registry, call) };
        const result = cancelledResult(call.name);
        yield { type: "tool_end", toolId: call.id, ok: false, summary: result.summary };
        results.push(toBlock(call, result));
      }
      continue;
    }

    if (!batch.concurrent) {
      const call = batch.calls[0]!;
      yield { type: "tool_start", toolId: call.id, name: call.name, argSummary: summaryOf(registry, call) };
      let result: ToolResult;
      try {
        result = await runOne(registry, call, context);
      } catch (error) {
        if (!isAbort(error)) throw error;
        cancelled = true;
        result = cancelledResult(call.name);
      }
      yield { type: "tool_end", toolId: call.id, ok: result.ok, summary: result.summary };
      results.push(toBlock(call, result));
      continue;
    }

    // 并发批：超过并发上限时切子批依次跑，子批之间仍保序。
    for (const subCalls of chunk(batch.calls, MAX_CONCURRENT_TOOLS)) {
      for (const call of subCalls) {
        yield { type: "tool_start", toolId: call.id, name: call.name, argSummary: summaryOf(registry, call) };
      }
      const settled = await Promise.all(subCalls.map((call) => runOne(registry, call, context)
        .catch((error: unknown) => {
          if (!isAbort(error)) throw error;
          cancelled = true;
          return cancelledResult(call.name);
        })));
      // 按调用在响应中的原始顺序回写，与实际完成先后无关（N6）。
      for (const [index, call] of subCalls.entries()) {
        const result = settled[index]!;
        yield { type: "tool_end", toolId: call.id, ok: result.ok, summary: result.summary };
        results.push(toBlock(call, result));
      }
    }
  }

  return results;
}
