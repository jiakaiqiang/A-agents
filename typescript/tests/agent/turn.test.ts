import { describe, expect, test } from "bun:test";
import { ConversationManager } from "../../src/conversation/conversation.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { StreamEvent, UsageInfo } from "../../src/llm/events.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { runTurn, type TurnCallbacks } from "../../src/agent/turn.js";

function usage(inputTokens: number, outputTokens: number): UsageInfo {
  return { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function callbacks(notices: Array<{ text: string; isError: boolean }> = []): TurnCallbacks {
  return {
    onText: () => undefined,
    onThinking: () => undefined,
    onToolStart: () => undefined,
    onToolEnd: () => undefined,
    onNotice: (text, isError) => notices.push({ text, isError }),
    onUsage: () => undefined,
    onPhase: () => undefined,
  };
}

function fakeClient(scripts: StreamEvent[][], receivedTools: Record<string, unknown>[][]): LLMClient {
  let index = 0;
  return {
    async *stream(_conversation, tools) {
      receivedTools.push(tools);
      for (const event of scripts[index++] ?? []) yield event;
    },
  };
}

function end(inputTokens = 1, outputTokens = 1): StreamEvent {
  return { type: "stream_end", stopReason: "end_turn", usage: usage(inputTokens, outputTokens) };
}

function tool(id: string, name = "Read", args: Record<string, unknown> = { file_path: "missing.txt" }): StreamEvent {
  return { type: "tool_call_complete", toolId: id, toolName: name, arguments: args };
}

async function run(
  scripts: StreamEvent[][],
  receivedTools: Record<string, unknown>[][],
  noticeList: Array<{ text: string; isError: boolean }> = [],
) {
  const conversation = new ConversationManager();
  conversation.addUserMessage("执行任务");
  const result = await runTurn({
    client: fakeClient(scripts, receivedTools),
    conversation,
    registry: createDefaultRegistry(),
    protocol: "openai-compat",
    workDir: process.cwd(),
    callbacks: callbacks(noticeList),
  });
  return { result, conversation };
}

describe("runTurn", () => {
  test("无工具时只请求一次", async () => {
    const requests: Record<string, unknown>[][] = [];
    const { result, conversation } = await run([[{ type: "text_delta", text: "你好" }, end()]], requests);
    expect(result.requestCount).toBe(1);
    expect(result.toolsExecuted).toBe(0);
    expect(conversation.getMessages().at(-1)).toEqual({ role: "assistant", content: "你好" });
    expect(requests[0]!.length).toBe(6);
  });

  test("一个工具请求后再进行一次无工具续答", async () => {
    const requests: Record<string, unknown>[][] = [];
    const { result, conversation } = await run([
      [tool("t1"), end(2, 3)],
      [{ type: "text_delta", text: "文件不存在" }, end(4, 5)],
    ], requests);
    const history = conversation.getMessages();
    expect(result.requestCount).toBe(2);
    expect(result.toolsExecuted).toBe(1);
    expect(requests[0]!.length).toBe(6);
    expect(requests[1]).toEqual([]);
    expect(history.find((item) => item.role === "assistant")?.toolUses?.[0]?.id).toBe("t1");
    expect(history.find((item) => item.toolResults)?.toolResults?.[0]?.toolUseId).toBe("t1");
    expect(history.at(-1)).toEqual({ role: "assistant", content: "文件不存在" });
  });

  test("多个工具只执行第一个但为每个调用回灌结果", async () => {
    const requests: Record<string, unknown>[][] = [];
    const notices: Array<{ text: string; isError: boolean }> = [];
    const { result, conversation } = await run([
      [tool("t1"), tool("t2", "Glob", { pattern: "**/*.ts" }), tool("t3", "Grep", { pattern: "TODO" }), end()],
      [{ type: "text_delta", text: "已处理" }, end()],
    ], requests, notices);
    const history = conversation.getMessages();
    expect(result.toolsExecuted).toBe(1);
    expect(history.find((item) => item.toolResults)?.toolResults).toHaveLength(3);
    expect(history.find((item) => item.toolResults)?.toolResults?.map((item) => item.toolUseId)).toEqual(["t1", "t2", "t3"]);
    expect(history.find((item) => item.toolResults)?.toolResults?.slice(1).every((item) => item.isError)).toBe(true);
    expect(notices.some((notice) => notice.text.includes("跳过"))).toBe(true);
  });

  test("续答阶段再次请求工具时不执行且不产生第三次请求", async () => {
    const requests: Record<string, unknown>[][] = [];
    const notices: Array<{ text: string; isError: boolean }> = [];
    const { result, conversation } = await run([
      [tool("t1"), end()],
      [{ type: "text_delta", text: "收尾" }, tool("t2"), end()],
    ], requests, notices);
    expect(result.requestCount).toBe(2);
    expect(requests).toHaveLength(2);
    expect(notices.some((notice) => notice.isError && notice.text.includes("最终续答"))).toBe(true);
    expect(conversation.getMessages().at(-1)).toEqual({ role: "assistant", content: "收尾" });
  });

  test("首次流中断时不抛异常且保持调用结果配对", async () => {
    const requests: Record<string, unknown>[][] = [];
    const interruptedClient: LLMClient = {
      async *stream(_conversation, tools) {
        requests.push(tools);
        yield { type: "tool_call_complete", toolId: "t1", toolName: "Read", arguments: { file_path: "a.txt" } };
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const conversation = new ConversationManager();
    conversation.addUserMessage("中断");
    const result = await runTurn({
      client: interruptedClient,
      conversation,
      registry: createDefaultRegistry(),
      protocol: "anthropic",
      workDir: process.cwd(),
      callbacks: callbacks(),
    });
    const history = conversation.getMessages();
    expect(result.aborted).toBe(true);
    expect(history.find((item) => item.role === "assistant")?.toolUses?.[0]?.id).toBe("t1");
    expect(history.find((item) => item.toolResults)?.toolResults?.[0]?.toolUseId).toBe("t1");
  });
});
