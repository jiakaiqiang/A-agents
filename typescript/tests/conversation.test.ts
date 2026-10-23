import { describe, expect, test } from "bun:test";
import { ConversationManager, type Message } from "../src/conversation/conversation.js";

describe("ConversationManager", () => {
  test("六类消息都同步通知记录器，压缩只追加检查点", () => {
    const appended: Message[] = [];
    const replaced: Message[][] = [];
    const conversation = new ConversationManager();
    conversation.setRecorder({ onAppend: (message) => appended.push(message), onReplace: (messages) => replaced.push(messages) });
    conversation.addUserMessage("user");
    conversation.addAssistantMessage("assistant");
    conversation.addAssistantFull("full", [{ thinking: "thought", signature: "sig" }]);
    conversation.addToolUseMessage("tool", [{ id: "t", name: "Read", arguments: {} }]);
    conversation.addToolResultMessage([{ toolUseId: "t", content: "result" }]);
    conversation.addSystemReminder("reminder");
    expect(appended).toEqual(conversation.getMessages());
    expect(appended).toHaveLength(6);
    conversation.replaceWithCompacted([{ role: "user", content: "summary" }]);
    expect(replaced).toEqual([[{ role: "user", content: "summary" }]]);
    expect(appended).toHaveLength(6);
  });

  test("恢复不重复通知记录器，取消挂钩后不再记录", () => {
    let count = 0;
    const conversation = new ConversationManager();
    conversation.setRecorder({ onAppend: () => count++, onReplace: () => count++ });
    const messages: Message[] = [{ role: "user", content: "restored" }];
    conversation.restore(messages);
    expect(conversation.getMessages()).toEqual(messages);
    messages[0]!.content = "changed";
    expect(conversation.getMessages()[0]!.content).toBe("restored");
    conversation.setRecorder(null);
    conversation.addUserMessage("next");
    expect(count).toBe(0);
  });
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

  test("展示文本与内容不同时才记录 display，并随记录器写出", () => {
    const appended: Message[] = [];
    const conversation = new ConversationManager();
    conversation.setRecorder({ onAppend: (message) => appended.push(message), onReplace: () => undefined });
    conversation.addUserMessage("请审查改动", "/review");
    conversation.addUserMessage("hi", "hi");
    conversation.addUserMessage("plain");
    expect(conversation.getMessages()[0]!.display).toBe("/review");
    expect("display" in appended[1]!).toBe(false);
    expect("display" in appended[2]!).toBe(false);
    expect(appended[0]).toEqual({ role: "user", content: "请审查改动", display: "/review" });
  });
});
