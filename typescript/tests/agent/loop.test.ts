import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMode } from "../../src/agent/events.js";
import { runLoop } from "../../src/agent/loop.js";
import { ConversationManager, type Message } from "../../src/conversation/conversation.js";
import { buildAnthropicMessages } from "../../src/llm/anthropic.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { StreamEvent, UsageInfo } from "../../src/llm/events.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { MAX_INVALID_ITERATIONS } from "../../src/tools/limits.js";

function usage(inputTokens: number, outputTokens: number): UsageInfo {
  return { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function end(inputTokens = 1, outputTokens = 1, stopReason = "end_turn"): StreamEvent {
  return { type: "stream_end", stopReason, usage: usage(inputTokens, outputTokens) };
}

/** 默认用 Glob：无匹配也返回成功结果，便于断言 toolsExecuted。 */
function toolCall(id: string, name = "Glob", args: Record<string, unknown> = { pattern: "no-such-*.xyz" }): StreamEvent {
  return { type: "tool_call_complete", toolId: id, toolName: name, arguments: args };
}

interface ClientSpy {
  client: LLMClient;
  receivedTools: Record<string, unknown>[][];
}

/** 按脚本逐次响应；脚本用尽后回退为纯文本，避免测试意外死循环。 */
function scriptedClient(scripts: StreamEvent[][], options: { onStream?: () => void } = {}): ClientSpy {
  const receivedTools: Record<string, unknown>[][] = [];
  let index = 0;
  return {
    receivedTools,
    client: {
      async *stream(_conversation, tools) {
        receivedTools.push(tools);
        options.onStream?.();
        const script = scripts[index++] ?? [{ type: "text_delta", text: "收尾" }, end()];
        for (const event of script) yield event;
      },
    },
  };
}

function throwingClient(error: Error, before: StreamEvent[] = []): ClientSpy {
  const receivedTools: Record<string, unknown>[][] = [];
  return {
    receivedTools,
    client: {
      async *stream(_conversation, tools) {
        receivedTools.push(tools);
        for (const event of before) yield event;
        throw error;
      },
    },
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function collect(
  client: LLMClient,
  options: {
    conversation?: ConversationManager;
    mode?: AgentMode;
    maxIterations?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ events: AgentEvent[]; conversation: ConversationManager; done: Extract<AgentEvent, { type: "done" }> }> {
  const conversation = options.conversation ?? new ConversationManager();
  if (conversation.len() === 0) conversation.addUserMessage("执行任务");
  const events: AgentEvent[] = [];
  for await (const event of runLoop({
    client,
    conversation,
    registry: createDefaultRegistry(),
    protocol: "openai-compat",
    workDir: process.cwd(),
    mode: options.mode ?? "execute",
    ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    events.push(event);
  }
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("最后一个事件必须是 done");
  return { events, conversation, done };
}

/** 逐条校验：每个 tool_use 消息后紧跟一条 tool_result 消息，且 id 一一配对。 */
function assertPaired(history: Message[]): void {
  for (const [index, message] of history.entries()) {
    if (!message.toolUses?.length) continue;
    const next = history[index + 1];
    expect(next?.toolResults?.map((item) => item.toolUseId)).toEqual(message.toolUses.map((item) => item.id));
  }
  for (const [index, message] of history.entries()) {
    if (!message.toolResults?.length) continue;
    expect(history[index - 1]?.toolUses?.length).toBe(message.toolResults.length);
  }
}

describe("runLoop 停止条件", () => {
  test("AC1 无工具调用时只请求一次", async () => {
    const spy = scriptedClient([[{ type: "text_delta", text: "你好" }, end()]]);
    const { done, conversation } = await collect(spy.client);

    expect(done.reason).toBe("complete");
    expect(done.iterations).toBe(1);
    expect(done.toolsExecuted).toBe(0);
    expect(done.finalText).toBe("你好");
    expect(spy.receivedTools).toHaveLength(1);
    expect(conversation.getMessages().at(-1)).toEqual({ role: "assistant", content: "你好" });
  });

  test("AC2/AC3 连续三次工具后自然完成，历史严格配对", async () => {
    const spy = scriptedClient([
      [toolCall("t1"), end()],
      [toolCall("t2"), end()],
      [toolCall("t3"), end()],
      [{ type: "text_delta", text: "都办好了" }, end()],
    ]);
    const { done, conversation } = await collect(spy.client);

    expect(done.reason).toBe("complete");
    expect(done.iterations).toBe(4);
    expect(done.toolsExecuted).toBe(3);
    expect(done.finalText).toBe("都办好了");
    expect(spy.receivedTools).toHaveLength(4);
    assertPaired(conversation.getMessages());
    expect(conversation.getMessages().at(-1)).toEqual({ role: "assistant", content: "都办好了" });
  });

  test("AC4/AC12 永远请求工具时在迭代上限处终止", async () => {
    const spy = scriptedClient(Array.from({ length: 30 }, (_unused, index) => [toolCall(`t${index}`), end()]));
    const { done, events } = await collect(spy.client, { maxIterations: 5 });

    expect(done.reason).toBe("max_iterations");
    expect(done.iterations).toBe(5);
    expect(spy.receivedTools).toHaveLength(5);
    // F30：上限中止的提示包含已执行迭代数，措辞与取消可区分。
    const notice = events.find((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice");
    expect(notice?.text).toContain("迭代上限");
    expect(notice?.text).toContain("5");
    expect(notice?.isError).toBe(true);
  });

  test("AC5 上限停止后补收尾消息，下一轮消息序列合法", async () => {
    const spy = scriptedClient(Array.from({ length: 10 }, (_unused, index) => [toolCall(`t${index}`), end()]));
    const { conversation } = await collect(spy.client, { maxIterations: 3 });

    const last = conversation.getMessages().at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContain("迭代上限");

    conversation.addUserMessage("继续");
    const messages = buildAnthropicMessages(conversation.getMessages());
    for (let index = 1; index < messages.length; index += 1) {
      expect(`${messages[index - 1]!.role}/${messages[index]!.role}`).not.toBe("user/user");
    }
  });

  test("AC8 模型流中取消不抛异常且会话可继续", async () => {
    const spy = throwingClient(abortError(), [{ type: "text_delta", text: "半句" }]);
    const { done, conversation, events } = await collect(spy.client);

    expect(done.reason).toBe("cancelled");
    expect(done.finalText).toBe("半句");
    // F10/F30：停止原因经事件流发出，取消的措辞为非错误样式。
    const notice = events.find((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice");
    expect(notice?.text).toContain("中断");
    expect(notice?.isError).toBe(false);

    const second = scriptedClient([[{ type: "text_delta", text: "第二轮正常" }, end()]]);
    conversation.addUserMessage("再来一次");
    const again = await collect(second.client, { conversation });
    expect(again.done.reason).toBe("complete");
  });

  test("AC9 工具阶段取消时全部调用回灌 cancelled 且保持配对", async () => {
    const controller = new AbortController();
    // 首次流产出工具调用后立即取消，使批次执行阶段看到已取消的 signal。
    const spy = scriptedClient(
      [[toolCall("t1"), toolCall("t2", "Grep", { pattern: "x" }), end()]],
      { onStream: () => controller.abort() },
    );
    const { done, conversation, events } = await collect(spy.client, { signal: controller.signal });

    expect(done.reason).toBe("cancelled");
    expect(done.toolsExecuted).toBe(0);
    // F10/F30：批次执行中取消同样要有一条可见的中止提示。
    const notice = events.find((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice");
    expect(notice?.text).toContain("中断");
    expect(notice?.isError).toBe(false);
    const history = conversation.getMessages();
    assertPaired(history);
    const results = history.find((message) => message.toolResults)?.toolResults ?? [];
    expect(results.map((item) => item.toolUseId)).toEqual(["t1", "t2"]);
    expect(results.every((item) => item.isError === true)).toBe(true);
    expect(history.at(-1)?.content).toContain("中断");
  });

  test("AC10 连续未知工具达阈值时停止", async () => {
    const spy = scriptedClient(Array.from({ length: 10 }, (_unused, index) => [
      toolCall(`t${index}`, "Nope", {}),
      end(),
    ]));
    const { done, conversation, events } = await collect(spy.client);

    expect(done.reason).toBe("invalid_tools");
    expect(done.iterations).toBe(MAX_INVALID_ITERATIONS);
    assertPaired(conversation.getMessages());
    // F30：未知工具中止的提示指明原因，与上限/取消措辞可区分。
    const notice = events.find((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice");
    expect(notice?.text).toContain("不存在的工具");
    expect(notice?.isError).toBe(true);
  });

  test("AC10 中途出现真工具时连续计数归零", async () => {
    const spy = scriptedClient([
      [toolCall("t1", "Nope", {}), end()],
      [toolCall("t2", "Nope", {}), end()],
      [toolCall("t3"), end()], // 真工具，计数归零
      [toolCall("t4", "Nope", {}), end()],
      [toolCall("t5", "Nope", {}), end()],
      [{ type: "text_delta", text: "结束" }, end()],
    ]);
    const { done } = await collect(spy.client);

    expect(done.reason).toBe("complete");
    expect(done.iterations).toBe(6);
    expect(done.toolsExecuted).toBe(1);
  });

  test("AC10 混合已知与未知工具不计为无效迭代", async () => {
    const spy = scriptedClient(Array.from({ length: 6 }, (_unused, index) => [
      toolCall(`k${index}`),
      toolCall(`u${index}`, "Nope", {}),
      end(),
    ]));
    const { done } = await collect(spy.client, { maxIterations: 4 });

    expect(done.reason).toBe("max_iterations");
    expect(done.iterations).toBe(4);
  });

  test("AC11 非取消错误被兜成 stream_error", async () => {
    const spy = throwingClient(new Error("boom"));
    const { done, conversation, events } = await collect(spy.client);

    expect(done.reason).toBe("stream_error");
    expect(done.errorMessage).toContain("boom");
    // F30：错误中止的提示为错误样式，与其他停止原因可区分。
    const notice = events.find((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice");
    expect(notice?.text).toContain("错误");
    expect(notice?.isError).toBe(true);

    const second = scriptedClient([[{ type: "text_delta", text: "恢复了" }, end()]]);
    conversation.addUserMessage("再试");
    expect((await collect(second.client, { conversation })).done.reason).toBe("complete");
  });

  test("工具执行后出错时历史仍被补上收尾消息", async () => {
    const scripts: StreamEvent[][] = [[toolCall("t1"), end()]];
    let calls = 0;
    const client: LLMClient = {
      async *stream() {
        calls += 1;
        if (calls > 1) throw new Error("second failed");
        for (const event of scripts[0]!) yield event;
      },
    };
    const { done, conversation } = await collect(client);

    expect(done.reason).toBe("stream_error");
    const history = conversation.getMessages();
    assertPaired(history);
    expect(history.at(-1)?.role).toBe("assistant");
  });
});

describe("runLoop 事件流", () => {
  test("AC14 一轮含工具的运行覆盖六类事件", async () => {
    const spy = scriptedClient([
      [{ type: "text_delta", text: "先看看" }, toolCall("t1"), end()],
      [{ type: "text_delta", text: "看完了" }, end()],
    ]);
    const { events } = await collect(spy.client);
    const types = new Set(events.map((event) => event.type));

    for (const expected of ["text", "tool_start", "tool_end", "usage", "progress", "done"]) {
      expect(types.has(expected as AgentEvent["type"])).toBe(true);
    }
  });

  test("AC15 事件顺序符合约定", async () => {
    const spy = scriptedClient([
      [{ type: "text_delta", text: "第一轮" }, toolCall("t1"), end()],
      [{ type: "text_delta", text: "第二轮" }, end()],
    ]);
    const { events } = await collect(spy.client);

    // done 是最后一项。
    expect(events.at(-1)!.type).toBe("done");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);

    // 第一个 progress 早于第一个 text 与第一个 tool_start。
    const firstProgress = events.findIndex((event) => event.type === "progress");
    expect(firstProgress).toBe(0);
    expect(firstProgress).toBeLessThan(events.findIndex((event) => event.type === "text"));
    expect(firstProgress).toBeLessThan(events.findIndex((event) => event.type === "tool_start"));

    // 同一 toolId 的 start 早于 end。
    const startIndex = events.findIndex((event) => event.type === "tool_start" && event.toolId === "t1");
    const endIndex = events.findIndex((event) => event.type === "tool_end" && event.toolId === "t1");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(endIndex);

    // 工具阶段的 progress 早于该轮的 tool_start。
    const toolsPhase = events.findIndex((event) => event.type === "progress" && event.phase === "tools");
    expect(toolsPhase).toBeLessThan(startIndex);
  });

  test("AC35 用量事件为本轮累计值", async () => {
    const spy = scriptedClient([
      [toolCall("t1"), end(10, 20)],
      [{ type: "text_delta", text: "好" }, end(5, 7)],
    ]);
    const { events } = await collect(spy.client);
    const usages = events.filter((event): event is Extract<AgentEvent, { type: "usage" }> => event.type === "usage");

    expect(usages).toHaveLength(2);
    expect(usages[0]!.usage).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    expect(usages[1]!.usage).toMatchObject({ inputTokens: 15, outputTokens: 27 });
  });

  test("progress 的 iteration 逐轮递增", async () => {
    const spy = scriptedClient([
      [toolCall("t1"), end()],
      [toolCall("t2"), end()],
      [{ type: "text_delta", text: "完成" }, end()],
    ]);
    const { events } = await collect(spy.client);
    const modelPhases = events
      .filter((event): event is Extract<AgentEvent, { type: "progress" }> => event.type === "progress" && event.phase === "model")
      .map((event) => event.iteration);

    expect(modelPhases).toEqual([1, 2, 3]);
  });
});

describe("runLoop 计划模式", () => {
  test("计划模式同样下发全部工具定义（权限 spec F19、AC18）", async () => {
    // 计划模式不再摘掉写类工具，对改文件的约束改由权限层逐次确认承担。
    const planSpy = scriptedClient([[{ type: "text_delta", text: "计划如下" }, end()]]);
    await collect(planSpy.client, { mode: "plan" });
    expect(planSpy.receivedTools[0]).toHaveLength(6);
    expect(planSpy.receivedTools[0]!.map((definition) => (definition.function as { name: string }).name))
      .toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);

    const execSpy = scriptedClient([[{ type: "text_delta", text: "开始改" }, end()]]);
    await collect(execSpy.client, { mode: "execute" });
    expect(execSpy.receivedTools[0]).toHaveLength(6);
  });

  test("AC29 计划模式下循环机制不变", async () => {
    const spy = scriptedClient([
      [toolCall("t1", "Grep", { pattern: "TODO" }), end()],
      [toolCall("t2"), end()],
      [{ type: "text_delta", text: "这是计划" }, end()],
    ]);
    const { done } = await collect(spy.client, { mode: "plan" });

    expect(done.reason).toBe("complete");
    expect(done.iterations).toBe(3);
    expect(done.finalText).toBe("这是计划");
    expect(spy.receivedTools.every((tools) => tools.length === 6)).toBe(true);
  });
});
