import { describe, expect, test } from "bun:test";
import { buildAnthropicMessages, buildSystemBlocks } from "../../src/llm/anthropic.js";
import { buildChatCompletionMessages, buildOpenAIInput } from "../../src/llm/openai.js";
import { ConversationManager } from "../../src/conversation/conversation.js";
import { wrapReminder } from "../../src/prompt/reminder.js";

const REMINDER = wrapReminder("仍在计划模式：只做调研和方案。");

const SEGMENTS = { stable: "# 身份\n稳定内容", environment: "# 运行环境\n- 日期：2026-09-09" };

function conversationWithUserTail(): ConversationManager {
  const conversation = new ConversationManager();
  conversation.addUserMessage("看一下 loop.ts");
  return conversation;
}

function conversationWithToolResultTail(): ConversationManager {
  const conversation = new ConversationManager();
  conversation.addUserMessage("读一下文件");
  conversation.addAssistantFull("", [], [{ id: "t1", name: "Read", arguments: { file_path: "a.ts" } }]);
  conversation.addToolResultMessage([{ toolUseId: "t1", content: "内容", isError: false }]);
  return conversation;
}

describe("buildSystemBlocks 的缓存分层", () => {
  test("系统内容分成两块，各自带缓存标记", () => {
    const blocks = buildSystemBlocks(SEGMENTS);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.type).toBe("text");
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  test("第一块是稳定段，第二块是环境段", () => {
    const blocks = buildSystemBlocks(SEGMENTS);
    expect(blocks[0]!.text).toBe(SEGMENTS.stable);
    expect(blocks[1]!.text).toBe(SEGMENTS.environment);
  });

  test("补充指令变化不影响两块内容与标记位置", () => {
    const conversation = conversationWithUserTail();
    const without = buildSystemBlocks(SEGMENTS);
    buildAnthropicMessages(conversation.getMessages(), [REMINDER]);
    const withReminder = buildSystemBlocks(SEGMENTS);
    // 补充指令走消息通道，动不到系统提示词这两个缓存单元。
    expect(withReminder).toEqual(without);
  });
});

describe("buildAnthropicMessages 的补充指令挂载", () => {
  test("不传补充指令时消息数组与历史一致", () => {
    const messages = buildAnthropicMessages(conversationWithUserTail().getMessages());
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("看一下 loop.ts");
  });

  test("末条是 user 文本时合并进同一条，不新增消息", () => {
    const messages = buildAnthropicMessages(conversationWithUserTail().getMessages(), [REMINDER]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe(`看一下 loop.ts\n\n${REMINDER}`);
  });

  test("末条是工具结果时追加成文本块，不产生连续两条 user", () => {
    const messages = buildAnthropicMessages(conversationWithToolResultTail().getMessages(), [REMINDER]);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[blocks.length - 1]).toMatchObject({ type: "text", text: REMINDER });
    // 相邻两条消息的角色不能相同，否则 Anthropic 会拒绝请求。
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i]!.role).not.toBe(messages[i - 1]!.role);
    }
  });

  test("多条补充指令用空行拼接", () => {
    const messages = buildAnthropicMessages(conversationWithUserTail().getMessages(), ["甲", "乙"]);
    expect(messages[0]!.content).toBe("看一下 loop.ts\n\n甲\n\n乙");
  });

  test("补充指令不写回会话历史", () => {
    const conversation = conversationWithUserTail();
    buildAnthropicMessages(conversation.getMessages(), [REMINDER]);
    const history = conversation.getMessages();
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("看一下 loop.ts");
  });

  test("连续三轮注入后历史里找不到任何补充指令内容", () => {
    const conversation = new ConversationManager();
    for (let turn = 1; turn <= 3; turn += 1) {
      conversation.addUserMessage(`第 ${turn} 轮请求`);
      buildAnthropicMessages(conversation.getMessages(), [wrapReminder(`第 ${turn} 轮的补充指令`)]);
      conversation.addAssistantMessage(`第 ${turn} 轮回复`);
    }
    const dumped = conversation.getMessages().map((entry) => entry.content).join("\n");
    expect(dumped).not.toContain("system-reminder");
    expect(dumped).not.toContain("补充指令");
  });

  test("本轮请求里不残留上一轮注入的内容", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("第一轮");
    buildAnthropicMessages(conversation.getMessages(), [wrapReminder("第一轮指令")]);
    conversation.addAssistantMessage("好");
    conversation.addUserMessage("第二轮");

    const second = buildAnthropicMessages(conversation.getMessages(), [wrapReminder("第二轮指令")]);
    const dumped = JSON.stringify(second);
    expect(dumped).toContain("第二轮指令");
    // 补充指令只挂在当次请求上，上一轮的必须彻底消失。
    expect(dumped).not.toContain("第一轮指令");
  });
});

describe("OpenAI 系协议的补充指令挂载", () => {
  test("Responses 协议追加成末尾 user 项", () => {
    const input = buildOpenAIInput(conversationWithUserTail().getMessages(), [REMINDER]) as unknown as Array<{
      role?: string;
      content?: string;
    }>;
    expect(input).toHaveLength(2);
    expect(input[1]).toEqual({ role: "user", content: REMINDER });
  });

  test("Chat Completions 协议追加成末尾 user 消息", () => {
    const messages = buildChatCompletionMessages(conversationWithToolResultTail().getMessages(), [REMINDER]);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toBe(REMINDER);
  });

  test("不传补充指令时两个 builder 都不额外加消息", () => {
    const history = conversationWithUserTail().getMessages();
    expect(buildOpenAIInput(history)).toHaveLength(1);
    expect(buildChatCompletionMessages(history)).toHaveLength(1);
  });

  test("三种协议构造的请求里都能找到补充指令内容", () => {
    const history = conversationWithUserTail().getMessages();
    const dumps = [
      JSON.stringify(buildAnthropicMessages(history, [REMINDER])),
      JSON.stringify(buildOpenAIInput(history, [REMINDER])),
      JSON.stringify(buildChatCompletionMessages(history, [REMINDER])),
    ];
    for (const dump of dumps) {
      expect(dump).toContain("system-reminder");
      expect(dump).toContain("仍在计划模式");
    }
  });
});
