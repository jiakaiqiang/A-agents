import { describe, expect, test } from "bun:test";
import { collectStream, type CollectedResponse } from "../../src/agent/collect.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { ConversationManager } from "../../src/conversation/conversation.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { StreamEvent, UsageInfo } from "../../src/llm/events.js";

function usage(inputTokens: number, outputTokens: number): UsageInfo {
  return { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function scriptedClient(events: StreamEvent[], thrown?: Error): LLMClient {
  return {
    async *stream() {
      for (const event of events) yield event;
      if (thrown) throw thrown;
    },
  };
}

/** 手动驱动生成器，同时拿到事件序列与 return 值。 */
async function drain(
  generator: AsyncGenerator<AgentEvent, CollectedResponse>,
): Promise<{ events: AgentEvent[]; response: CollectedResponse }> {
  const events: AgentEvent[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done) return { events, response: step.value };
    events.push(step.value);
  }
}

function run(events: StreamEvent[], thrown?: Error) {
  return drain(collectStream(scriptedClient(events, thrown), new ConversationManager(), [], undefined));
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

describe("collectStream", () => {
  test("双路输出的文本完全一致", async () => {
    const { events, response } = await run([
      { type: "text_delta", text: "你" },
      { type: "text_delta", text: "好呀" },
      { type: "stream_end", stopReason: "end_turn", usage: usage(3, 4) },
    ]);

    const streamed = events
      .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(streamed).toBe("你好呀");
    expect(response.text).toBe("你好呀");
    expect(response.aborted).toBe(false);
  });

  test("完整响应含思考块、工具调用、停止原因与用量", async () => {
    const { response } = await run([
      { type: "thinking_delta", text: "想一下" },
      { type: "thinking_complete", thinking: "想一下", signature: "sig" },
      { type: "tool_call_complete", toolId: "t1", toolName: "Read", arguments: { file_path: "a.txt" } },
      { type: "tool_call_complete", toolId: "t2", toolName: "Edit", arguments: {}, parseError: "Unexpected end" },
      { type: "stream_end", stopReason: "tool_use", usage: usage(10, 20) },
    ]);

    expect(response.thinkingBlocks).toEqual([{ thinking: "想一下", signature: "sig" }]);
    expect(response.toolUses.map((call) => call.id)).toEqual(["t1", "t2"]);
    expect(response.toolUses[0]!.parseError).toBeUndefined();
    expect(response.toolUses[1]!.parseError).toContain("Unexpected end");
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(20);
  });

  test("取消时保留已收内容且不抛异常", async () => {
    const { response } = await run([{ type: "text_delta", text: "半句" }], abortError());
    expect(response.aborted).toBe(true);
    expect(response.text).toBe("半句");
  });

  test("非取消错误原样抛出交由循环兜底", async () => {
    const generator = collectStream(
      scriptedClient([{ type: "text_delta", text: "x" }], new Error("boom")),
      new ConversationManager(),
      [],
      undefined,
    );
    await expect(drain(generator)).rejects.toThrow("boom");
  });

  test("收集器不产出 usage 事件（累计由循环负责）", async () => {
    const { events } = await run([
      { type: "text_delta", text: "hi" },
      { type: "stream_end", stopReason: "end_turn", usage: usage(1, 2) },
    ]);
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });

  test("tool_call_start 与 tool_call_delta 不产生事件", async () => {
    const { events } = await run([
      { type: "tool_call_start", toolId: "t1", toolName: "Read" },
      { type: "tool_call_delta", text: "{\"file" },
      { type: "tool_call_complete", toolId: "t1", toolName: "Read", arguments: { file_path: "a.txt" } },
      { type: "stream_end", stopReason: "tool_use", usage: usage(1, 1) },
    ]);
    expect(events).toEqual([]);
  });
});
