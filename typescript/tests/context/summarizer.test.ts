import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/conversation/conversation.js";
import {
  buildSummaryPrompt,
  generateSummary,
  SUMMARY_KEEP_TURNS,
  truncateForSummary,
} from "../../src/context/summarizer.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.js";

interface ClientSpy {
  client: LLMClient;
  receivedTools: Record<string, unknown>[][];
  receivedMessages: Message[][];
  receivedReminders: string[][];
}

function fakeClient(events: StreamEvent[]): ClientSpy {
  const receivedTools: Record<string, unknown>[][] = [];
  const receivedMessages: Message[][] = [];
  const receivedReminders: string[][] = [];
  return {
    receivedTools,
    receivedMessages,
    receivedReminders,
    client: {
      async *stream(conversation, tools, options) {
        receivedTools.push(tools);
        receivedMessages.push(conversation.getMessages());
        receivedReminders.push(options?.reminders ?? []);
        for (const event of events) yield event;
      },
    },
  };
}

function end(inputTokens = 10, outputTokens = 5): StreamEvent {
  return {
    type: "stream_end",
    stopReason: "end_turn",
    usage: { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}

function history(count: number): Message[] {
  return Array.from({ length: count }, (_value, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `消息 ${index}`,
  }));
}

describe("buildSummaryPrompt", () => {
  test("system 部分含三条硬规则", () => {
    const { system } = buildSummaryPrompt(history(2));
    expect(system).toContain("禁止调用任何工具");
    expect(system).toContain("草稿");
    expect(system).toContain("用完即弃");
  });

  test("user 部分含九段结构", () => {
    const { user } = buildSummaryPrompt(history(2));
    for (const section of [
      "主要请求和意图",
      "关键技术概念",
      "文件和代码段",
      "错误和修复",
      "问题解决过程",
      "所有用户消息",
      "待办任务",
      "当前工作",
      "可能的下一步",
    ]) {
      expect(user).toContain(section);
    }
  });

  test("待摘要消息被转储进 user 文本", () => {
    const messages: Message[] = [
      { role: "user", content: "帮我改代码" },
      { role: "assistant", content: "好的", toolUses: [{ id: "t1", name: "Read", arguments: { file_path: "a.ts" } }] },
      { role: "user", content: "", toolResults: [{ toolUseId: "t1", content: "文件内容" }] },
    ];
    const { user } = buildSummaryPrompt(messages);
    expect(user).toContain("帮我改代码");
    expect(user).toContain("Read");
    expect(user).toContain("文件内容");
  });
});

describe("truncateForSummary", () => {
  test("短历史原样返回", () => {
    const messages = history(4);
    expect(truncateForSummary(messages)).toEqual(messages);
  });

  test("长历史保留尾部若干条并加占位，不改原数组", () => {
    const messages = history(30);
    const truncated = truncateForSummary(messages);
    expect(truncated[0]!.content).toBe("[更早的对话已省略]");
    expect(truncated.length).toBe(SUMMARY_KEEP_TURNS * 2 + 1);
    expect(truncated.at(-1)!.content).toBe("消息 29");
    expect(messages.length).toBe(30); // 原数组未被修改
  });
});

describe("generateSummary", () => {
  test("拼接 text_delta 为摘要，tools 传空数组", async () => {
    const spy = fakeClient([
      { type: "text_delta", text: "摘要" },
      { type: "text_delta", text: "内容" },
      end(),
    ]);
    const result = await generateSummary(spy.client, history(4), () => 100, 10_000);
    expect(result.summary).toBe("摘要内容");
    expect(spy.receivedTools[0]).toEqual([]); // 模型物理上无工具可调（F9）
    expect(result.usage.inputTokens).toBe(10);
  });

  test("system 规则通过 reminders 挂上请求", async () => {
    const spy = fakeClient([{ type: "text_delta", text: "x" }, end()]);
    await generateSummary(spy.client, history(4), () => 100, 10_000);
    expect(spy.receivedReminders[0]!.join("")).toContain("禁止调用任何工具");
  });

  test("超出预算时请求副本被截短", async () => {
    const spy = fakeClient([{ type: "text_delta", text: "x" }, end()]);
    const long = history(40);
    // 估算恒超预算 → 必然走截短路径
    await generateSummary(spy.client, long, () => 999_999, 10_000);
    const sent = spy.receivedMessages[0]![0]!.content;
    expect(sent).toContain("[更早的对话已省略]");
    expect(sent).not.toContain("消息 0\n");
  });
});
