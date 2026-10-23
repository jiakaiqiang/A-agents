import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Compactor, BOUNDARY_TEXT } from "../../src/context/compactor.js";
import { TokenEstimator } from "../../src/context/tokens.js";
import { ConversationManager, type Message } from "../../src/conversation/conversation.js";
import { displayMessages, formatGap, resumeSession } from "../../src/memory/resume.js";
import { newSessionId, readSessionLines, rebuildHistory, sessionsDir, SessionWriter } from "../../src/memory/session.js";
import { fixture, textClient } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

function setup(messages: Message[], ts = new Date().toISOString()) {
  const id = newSessionId();
  f.write(join(sessionsDir(f.workDir), `${id}.jsonl`), messages.map((message) => JSON.stringify({ type: "message", ts, message })).join("\n") + "\n");
  return { id, workDir: f.workDir, conversation: new ConversationManager(), writer: new SessionWriter(id, f.workDir) };
}

test("正常恢复不重复记录，之后续写同一文件", async () => {
  const options = setup([{ role: "user", content: "记住42" }, { role: "assistant", content: "好" }]);
  const result = await resumeSession(options);
  expect(result.display).toEqual(options.conversation.getMessages());
  expect(result.messageCount).toBe(2);
  expect(readSessionLines(f.workDir, options.id)).toHaveLength(2);
  options.conversation.addUserMessage("是什么？");
  expect(rebuildHistory(readSessionLines(f.workDir, options.id)).messages).toEqual(options.conversation.getMessages());
});

test("损坏与未完成工具调用恢复后，再次恢复仍保留新对话", async () => {
  const options = setup([{ role: "user", content: "保留" }, { role: "assistant", content: "", toolUses: [{ id: "t1", name: "Read", arguments: {} }] }]);
  appendFileSync(join(sessionsDir(f.workDir), `${options.id}.jsonl`), 'bad\n{"type":');
  const result = await resumeSession(options);
  expect(result.skippedLines).toBe(2);
  expect(result.truncated).toBe(true);
  expect(options.conversation.len()).toBe(1);
  options.conversation.addUserMessage("恢复后新增");
  const again = await resumeSession({ ...options, writer: new SessionWriter(options.id, f.workDir) });
  expect(again.truncated).toBe(false);
  expect(options.conversation.getMessages().map((m) => m.content)).toEqual(["保留", "恢复后新增"]);
});

test("超过四小时添加持久提醒，三小时不添加", async () => {
  const ts = "2026-10-19T00:00:00Z";
  const options = setup([{ role: "user", content: "hello" }], ts);
  const early = await resumeSession({ ...options, now: new Date("2026-10-19T03:00:00Z") });
  expect(early.gapReminder).toBeNull();
  const late = await resumeSession({ ...options, now: new Date("2026-10-19T05:00:00Z") });
  expect(late.gapReminder).toContain("5 小时");
  expect(options.conversation.getMessages().at(-1)?.content).toContain("<system-reminder>");
  expect(readSessionLines(f.workDir, options.id)).toHaveLength(2);
  expect(late.display).toHaveLength(1);
  expect(formatGap(2 * 86_400_000)).toBe("2 天");
});

test("超线恢复先压缩，压缩结果落盘；失败时仍能继续对话", async () => {
  const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "字".repeat(1500) }));
  const options = setup(messages);
  const compactor = new Compactor(textClient("摘要内容"), options.conversation, new TokenEstimator(), f.workDir, 15_000);
  const result = await resumeSession({ ...options, compactor });
  expect(result.compaction).toBe("done");
  expect(result.display[0]?.content).toContain("已压缩为摘要");
  expect(JSON.parse(readSessionLines(f.workDir, options.id).at(-1)!).type).toBe("compaction");
  const failed = setup(messages);
  const failing = new Compactor({ async *stream() { throw new Error("offline"); } }, failed.conversation, new TokenEstimator(), f.workDir, 15_000);
  expect((await resumeSession({ ...failed, compactor: failing })).compaction).toBe("failed");
  expect(failed.conversation.getMessages()).toEqual(messages);
  failed.conversation.addUserMessage("继续");
  expect(readSessionLines(f.workDir, failed.id)).toHaveLength(9);
});

test("回放只显示自然语言与摘要折叠，不重放工具、提醒、边界", () => {
  const messages: Message[] = [
    { role: "user", content: "【历史摘要】\n旧内容" }, { role: "user", content: "新问题" },
    { role: "assistant", content: "检查中", toolUses: [{ id: "t", name: "Read", arguments: {} }] },
    { role: "user", content: "", toolResults: [{ toolUseId: "t", content: "secret" }] },
    { role: "user", content: BOUNDARY_TEXT }, { role: "user", content: "<system-reminder>提示</system-reminder>" },
    { role: "system", content: "hidden" }, { role: "assistant", content: "回答" },
  ];
  expect(displayMessages(messages, 1).map((m) => m.content)).toEqual(["（较早的对话已压缩为摘要）", "新问题", "检查中", "回答"]);
});

test("读取失败保留当前历史与记录器", async () => {
  const options = setup([{ role: "user", content: "saved" }]);
  options.conversation.addUserMessage("current");
  const missing = newSessionId();
  await expect(resumeSession({ ...options, id: missing, writer: new SessionWriter(missing, f.workDir) })).rejects.toThrow();
  expect(options.conversation.getMessages()[0]?.content).toBe("current");
});

test("恢复时优先显示原命令，模型历史仍是展开文本；旧记录照常显示", async () => {
  const options = setup([
    { role: "user", content: "请审查改动\n\n审查范围：src/tui", display: "/review src/tui" },
    { role: "assistant", content: "审查结果" },
    { role: "user", content: "旧记录" },
  ]);
  const result = await resumeSession(options);
  expect(result.display.map((item) => item.content)).toEqual(["/review src/tui", "审查结果", "旧记录"]);
  expect(options.conversation.getMessages()[0]!.content).toBe("请审查改动\n\n审查范围：src/tui");
});
