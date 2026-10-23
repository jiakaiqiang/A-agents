import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Compactor,
  KEEP_RECENT_NATURAL,
  MAX_SUMMARY_FAILURES,
  MESSAGE_SPILL_TOKENS,
  splitHistory,
  TOOL_SPILL_TOKENS,
} from "../../src/context/compactor.js";
import { TokenEstimator } from "../../src/context/tokens.js";
import { ConversationManager, type Message, type ToolResultBlock } from "../../src/conversation/conversation.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.js";
import { rebuildHistory } from "../../src/memory/session.js";

let workDir = "";

test("压缩分界保留完整工具配对，落盘后可再次重建", async () => {
  const conversation = new ConversationManager();
  conversation.addUserMessage("旧问题");
  conversation.addAssistantMessage("旧回答");
  conversation.addToolUseMessage("读取", [{ id: "read-1", name: "Read", arguments: {} }]);
  conversation.addToolResultMessage([{ toolUseId: "read-1", content: "x".repeat(44_000) }]);
  const split = splitHistory(conversation.getMessages());
  expect(split.recent[0]?.toolUses?.[0]?.id).toBe("read-1");
  const compactor = new Compactor(summarizingClient().client, conversation, new TokenEstimator(), workDir, 100_000);
  expect((await compactor.compactManually()).compacted).toBe(true);
  const rebuilt = rebuildHistory([JSON.stringify({ type: "compaction", ts: new Date().toISOString(), messages: conversation.getMessages() })]);
  expect(rebuilt.truncatedFrom).toBeNull();
  expect(rebuilt.messages).toEqual(conversation.getMessages());
});

test("needsCompaction 与自动阈值一致且不受熔断影响", async () => {
  const conversation = new ConversationManager();
  const compactor = new Compactor(failingClient().client, conversation, new TokenEstimator(), workDir, 15_000);
  conversation.addUserMessage("short");
  expect(compactor.needsCompaction()).toBe(false);
  conversation.addAssistantMessage("x".repeat(12_000));
  expect(compactor.needsCompaction()).toBe(true);
  for (let i = 0; i < MAX_SUMMARY_FAILURES; i++) await compactor.compactManually();
  expect(compactor.circuitOpen).toBe(true);
  expect(compactor.needsCompaction()).toBe(true);
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mewcode-compact-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function end(): StreamEvent {
  return {
    type: "stream_end",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}

function summarizingClient(summary = "结构化摘要"): { client: LLMClient; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    client: {
      async *stream() {
        state.calls += 1;
        yield { type: "text_delta", text: summary } as StreamEvent;
        yield end();
      },
    },
  };
}

function failingClient(): { client: LLMClient; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    client: {
      // eslint-disable-next-line require-yield -- 故意在产出前抛错
      async *stream() {
        state.calls += 1;
        throw new Error("摘要请求失败");
      },
    },
  };
}

function naturalMessage(index: number, chars = 40): Message {
  return { role: index % 2 === 0 ? "user" : "assistant", content: "字".repeat(chars) };
}

function toolResultMessage(chars: number): Message {
  return { role: "user", content: "", toolResults: [{ toolUseId: "t", content: "x".repeat(chars) }] };
}

function buildCompactor(client: LLMClient, messages: Message[], contextWindow: number) {
  const conversation = new ConversationManager();
  conversation.replaceWithCompacted(messages);
  const compactor = new Compactor(client, conversation, new TokenEstimator(), workDir, contextWindow);
  return { compactor, conversation };
}

describe("splitHistory", () => {
  test("自然语言条数先到：保留最近 5 条自然语言消息", () => {
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index));
    const split = splitHistory(messages);
    expect(split.recent.length).toBe(KEEP_RECENT_NATURAL);
    expect(split.toSummarize.length).toBe(12 - KEEP_RECENT_NATURAL);
    expect(split.recent.at(-1)).toEqual(messages.at(-1)!);
  });

  test("token 先到：一条巨大的工具结果就吃满 10K 线", () => {
    const messages: Message[] = [
      naturalMessage(0),
      naturalMessage(1),
      toolResultMessage(45_000), // ≈11250 tokens，超过 10K 线
    ];
    const split = splitHistory(messages);
    expect(split.recent.length).toBe(1);
    expect(split.toSummarize.length).toBe(2);
  });

  test("工具结果消息不占自然语言名额但 token 照算", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 4; index += 1) {
      messages.push(naturalMessage(index), toolResultMessage(20));
    }
    const split = splitHistory(messages);
    // 4 条自然语言未达 5 条线，全部落入近期区
    expect(split.toSummarize.length).toBe(0);
    expect(split.recent.length).toBe(messages.length);
  });

  test("历史太短时全部落入近期区", () => {
    const messages = [naturalMessage(0)];
    const split = splitHistory(messages);
    expect(split.toSummarize).toEqual([]);
    expect(split.recent.length).toBe(1);
  });
});

describe("applyLightPrevention", () => {
  test("单条超 2K tokens 的结果被替换为预览", async () => {
    const { compactor } = buildCompactor(summarizingClient().client, [], 200_000);
    const big = "x".repeat((TOOL_SPILL_TOKENS + 100) * 4);
    const blocks: ToolResultBlock[] = [{ toolUseId: "a", content: big }];
    const processed = await compactor.applyLightPrevention(blocks, new Map([["a", "Read"]]));
    expect(processed[0]!.content).toContain("完整输出已存盘");
    expect(processed[0]!.content.length).toBeLessThan(big.length);
    expect(readdirSync(join(workDir, ".mewcode", "tool-outputs"))[0]).toMatch(/^Read-/);
  });

  test("未超阈值的结果原样保留", async () => {
    const { compactor } = buildCompactor(summarizingClient().client, [], 200_000);
    const blocks: ToolResultBlock[] = [{ toolUseId: "a", content: "短结果" }];
    const processed = await compactor.applyLightPrevention(blocks);
    expect(processed[0]!.content).toBe("短结果");
  });

  test("合计超 8K 时从最大的开始依次存盘至达标", async () => {
    const { compactor } = buildCompactor(summarizingClient().client, [], 200_000);
    // 每条 1.8K tokens（单条不超 2K），6 条合计 ≈10.8K 超 8K 线
    const each = "y".repeat(1_800 * 4);
    const blocks: ToolResultBlock[] = Array.from({ length: 6 }, (_v, index) => ({
      toolUseId: `t${index}`,
      content: each,
    }));
    const processed = await compactor.applyLightPrevention(blocks, new Map([["t0", "Grep"]]));
    const total = processed.reduce((sum, block) => sum + Math.ceil(block.content.length / 4), 0);
    expect(total).toBeLessThanOrEqual(MESSAGE_SPILL_TOKENS);
    expect(processed.some((block) => block.content.includes("完整输出已存盘"))).toBe(true);
    expect(readdirSync(join(workDir, ".mewcode", "tool-outputs"))[0]).toMatch(/^Grep-/);
  });
});

describe("maintain", () => {
  test("估算超过窗口−13K 时触发压缩并替换历史", async () => {
    const spy = summarizingClient();
    // 窗口 20K，安全线 = 20K−13K = 7K；历史 ≈10K tokens 必然超线
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 3_500));
    const { compactor, conversation } = buildCompactor(spy.client, messages, 20_000);

    const notice = await compactor.maintain();
    expect(notice).toContain("已压缩历史");
    expect(notice).toContain("摘要内容：");
    expect(notice).toMatch(/上下文已从约 \d+ tokens 压缩到约 \d+ tokens/);
    expect(spy.calls).toBe(1);

    const history = conversation.getMessages();
    expect(history[0]!.content).toContain("结构化摘要");
    expect(history.at(-1)!.content).toContain("请用 Read 重新读取原文件");
    expect(history.length).toBe(KEEP_RECENT_NATURAL + 2); // 摘要 + 近期 5 条 + 边界
  });

  test("未超线时不触发压缩", async () => {
    const spy = summarizingClient();
    const messages = [naturalMessage(0, 100)];
    const { compactor, conversation } = buildCompactor(spy.client, messages, 200_000);

    expect(await compactor.maintain()).toBeNull();
    expect(spy.calls).toBe(0);
    expect(conversation.getMessages().length).toBe(1);
  });

  test("压缩后估算锚点被重置", async () => {
    const spy = summarizingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 3_500));
    const { compactor } = buildCompactor(spy.client, messages, 20_000);
    compactor.noteUsage(100_000, 9_999);
    expect(compactor.estimator.anchored).toBe(true);

    await compactor.maintain();
    expect(compactor.estimator.anchored).toBe(false);
  });

  test("近期原文区内容逐字保留", async () => {
    const spy = summarizingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 3_500));
    const { compactor, conversation } = buildCompactor(spy.client, messages, 20_000);

    await compactor.maintain();
    const history = conversation.getMessages();
    const recent = history.slice(1, -1);
    expect(recent).toEqual(messages.slice(-KEEP_RECENT_NATURAL));
  });
});

describe("熔断", () => {
  test("连续失败 3 次后熔断，maintain 不再调用 client", async () => {
    const spy = failingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 3_500));
    const { compactor, conversation } = buildCompactor(spy.client, messages, 20_000);

    const notices: Array<string | null> = [];
    for (let attempt = 0; attempt < MAX_SUMMARY_FAILURES; attempt += 1) {
      notices.push(await compactor.maintain());
    }
    expect(compactor.circuitOpen).toBe(true);
    expect(spy.calls).toBe(MAX_SUMMARY_FAILURES);
    expect(notices.slice(0, -1)).toEqual([null, null]);
    expect(notices.at(-1)).toContain("已暂停自动压缩");

    // 熔断后不再发请求，历史保持原样
    await compactor.maintain();
    expect(spy.calls).toBe(MAX_SUMMARY_FAILURES);
    expect(conversation.getMessages().length).toBe(messages.length);
  });

  test("resetFailures 后自动压缩恢复", async () => {
    const spy = failingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 3_500));
    const { compactor } = buildCompactor(spy.client, messages, 20_000);

    for (let attempt = 0; attempt < MAX_SUMMARY_FAILURES; attempt += 1) {
      await compactor.maintain();
    }
    compactor.resetFailures();
    expect(compactor.circuitOpen).toBe(false);

    await compactor.maintain();
    expect(spy.calls).toBe(MAX_SUMMARY_FAILURES + 1); // 恢复后重新尝试
  });
});

describe("compactManually", () => {
  test("无阈值直接压缩，且成功后熔断解除", async () => {
    const spy = summarizingClient();
    // 窗口极大，自动线远未触及
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 40));
    const { compactor, conversation } = buildCompactor(spy.client, messages, 1_000_000);

    expect(await compactor.maintain()).toBeNull(); // 自动不触发
    const result = await compactor.compactManually();
    expect(result.compacted).toBe(true);
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens!);
    expect(spy.calls).toBe(1);
    expect(conversation.getMessages()[0]!.content).toContain("结构化摘要");
    expect(compactor.failureCount).toBe(0);
  });

  test("失败时返回错误并累计熔断计数", async () => {
    const spy = failingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 40));
    const { compactor } = buildCompactor(spy.client, messages, 1_000_000);

    const result = await compactor.compactManually();
    expect(result.compacted).toBe(false);
    expect(result.error).toContain("摘要请求失败");
    expect(compactor.failureCount).toBe(1);
  });

  test("remainingTokens 反映压缩后的剩余空间", async () => {
    const spy = summarizingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 40));
    const { compactor } = buildCompactor(spy.client, messages, 1_000_000);

    await compactor.compactManually();
    expect(compactor.remainingTokens()).toBeGreaterThan(0);
    expect(compactor.remainingTokens()).toBeLessThan(1_000_000);
  });
});

describe("中断", () => {
  test("signal 已取消时不替换历史", async () => {
    const spy = summarizingClient();
    const messages = Array.from({ length: 12 }, (_v, index) => naturalMessage(index, 3_500));
    const { compactor, conversation } = buildCompactor(spy.client, messages, 20_000);

    const controller = new AbortController();
    controller.abort();
    await compactor.maintain(controller.signal);

    expect(conversation.getMessages().length).toBe(messages.length);
  });
});
