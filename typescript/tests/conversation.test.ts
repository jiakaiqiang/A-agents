import { describe, expect, test } from "bun:test";
import { ConversationManager } from "../src/conversation/conversation.js";

describe("ConversationManager", () => {
  test("按顺序保存用户和助手消息", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("你好");
    conversation.addAssistantMessage("你好，有什么可以帮你？");
    expect(conversation.getMessages()).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
    ]);
  });

  test("返回副本且支持截断", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("第一条");
    conversation.addAssistantMessage("第二条");
    const copy = conversation.getMessages();
    copy.pop();
    expect(conversation.len()).toBe(2);
    conversation.truncateTo(1);
    expect(conversation.getMessages()).toEqual([{ role: "user", content: "第一条" }]);
  });
});
