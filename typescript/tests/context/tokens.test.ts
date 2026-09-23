import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/conversation/conversation.js";
import { CHARS_PER_TOKEN, estimateChars, TokenEstimator } from "../../src/context/tokens.js";

function userMessage(content: string): Message {
  return { role: "user", content };
}

describe("estimateChars", () => {
  test("自然语言消息按正文长度计", () => {
    expect(estimateChars(userMessage("12345"))).toBe(5);
  });

  test("工具结果按各项 content 之和计", () => {
    const message: Message = {
      role: "user",
      content: "",
      toolResults: [
        { toolUseId: "a", content: "1234" },
        { toolUseId: "b", content: "567" },
      ],
    };
    expect(estimateChars(message)).toBe(7);
  });

  test("工具调用按参数 JSON 长度计", () => {
    const args = { pattern: "*.ts" };
    const message: Message = {
      role: "assistant",
      content: "调用",
      toolUses: [{ id: "t1", name: "Glob", arguments: args }],
    };
    expect(estimateChars(message)).toBe(2 + JSON.stringify(args).length);
  });
});

describe("TokenEstimator", () => {
  test("无锚点时全量按字符折算", () => {
    const estimator = new TokenEstimator();
    expect(estimator.anchored).toBe(false);
    expect(estimator.estimate(1000)).toBe(1000 / CHARS_PER_TOKEN);
  });

  test("有锚点时只对增量折算", () => {
    const estimator = new TokenEstimator();
    estimator.setAnchor(4000, 1000);
    // 锚点 1000 tokens + 增量 4000 字符 / 4
    expect(estimator.estimate(8000)).toBe(2000);
  });

  test("历史比锚点短时增量取 0，不出现负估算", () => {
    const estimator = new TokenEstimator();
    estimator.setAnchor(4000, 1000);
    expect(estimator.estimate(2000)).toBe(1000);
  });

  test("resetAnchor 后回到纯字符估算", () => {
    const estimator = new TokenEstimator();
    estimator.setAnchor(4000, 1000);
    estimator.resetAnchor();
    expect(estimator.anchored).toBe(false);
    expect(estimator.estimate(8000)).toBe(2000);
  });

  test("estimateMessages 汇总三类消息的字符口径", () => {
    const estimator = new TokenEstimator();
    const messages: Message[] = [
      userMessage("a".repeat(400)),
      { role: "user", content: "", toolResults: [{ toolUseId: "x", content: "b".repeat(400) }] },
    ];
    expect(estimator.sumChars(messages)).toBe(800);
    expect(estimator.estimateMessages(messages)).toBe(200);
  });
});
