import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ConversationManager, type Message } from "../../src/conversation/conversation.js";
import { cleanupExpiredSessions, listSessions, newSessionId, readSessionLines, rebuildHistory, sessionsDir, SessionWriter } from "../../src/memory/session.js";
import { sessionLockPath } from "../../src/memory/lock.js";
import { fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());
const message = (content: string): Message => ({ role: "user", content });
const line = (content: string, ts = "2026-10-19T00:00:00Z") => JSON.stringify({ type: "message", ts, message: message(content) });

test("会话 ID 格式、冲突重试与延迟创建", () => {
  let rejected = "";
  const id = newSessionId(new Date(2026, 9, 19, 1, 2, 3), (candidate) => {
    if (!rejected) { rejected = candidate; return true; }
    return candidate === rejected;
  });
  expect(id).toMatch(/^20261019-010203-[a-f0-9]{4}$/);
  expect(id).not.toBe(rejected);
  const writer = new SessionWriter(id, f.workDir);
  expect(existsSync(sessionsDir(f.workDir))).toBe(false);
  writer.onAppend(message("hello"));
  expect(readSessionLines(f.workDir, id)).toHaveLength(1);
});

test("完整消息与压缩检查点同步追加，历史原始记录不变", () => {
  const id = newSessionId();
  const conversation = new ConversationManager();
  conversation.setRecorder(new SessionWriter(id, f.workDir));
  conversation.addUserMessage("read");
  conversation.addAssistantFull("检查", [{ thinking: "思考", signature: "sig" }], [{ id: "t1", name: "Read", arguments: { path: "a" } }]);
  conversation.addToolResultMessage([{ toolUseId: "t1", content: "完整输出", isError: false }]);
  conversation.addAssistantMessage("完成");
  conversation.addSystemReminder("提示");
  const original = readFileSync(join(sessionsDir(f.workDir), `${id}.jsonl`), "utf8");
  expect(rebuildHistory(readSessionLines(f.workDir, id)).messages).toEqual(conversation.getMessages());
  conversation.replaceWithCompacted([message("【历史摘要】\n内容")]);
  const saved = readFileSync(join(sessionsDir(f.workDir), `${id}.jsonl`), "utf8");
  expect(saved.startsWith(original)).toBe(true);
  expect(readSessionLines(f.workDir, id)).toHaveLength(6);
  expect(rebuildHistory(readSessionLines(f.workDir, id)).summaryCount).toBe(1);
});

test("目录不可写只提示一次，对话照常进行", () => {
  f.write(sessionsDir(f.workDir), "blocked");
  const errors: string[] = [];
  const writer = new SessionWriter(newSessionId(), f.workDir, (error) => errors.push(error));
  writer.onAppend(message("a"));
  writer.onAppend(message("b"));
  writer.onReplace([]);
  expect(errors).toHaveLength(1);
});

test("坏行和非法嵌套字段跳过，最后压缩记录作为基线", () => {
  const result = rebuildHistory([
    line("旧消息"), "bad", '{"type":',
    JSON.stringify({ type: "message", ts: "bad", message: message("bad") }),
    JSON.stringify({ type: "message", ts: "2026-01-01", message: { ...message("bad"), toolResults: [null] } }),
    JSON.stringify({ type: "compaction", ts: "2026-10-19", messages: [message("【历史摘要】\n压缩内容")] }),
    line("新消息"),
  ]);
  expect(result.skippedLines).toBe(4);
  expect(result.messages.map((m) => m.content)).toEqual(["【历史摘要】\n压缩内容", "新消息"]);
  expect(result.summaryCount).toBe(1);
});

test("工具结果不全或孤立时截断，完整配对保留", () => {
  const ts = new Date().toISOString();
  const call: Message = { role: "assistant", content: "", toolUses: [{ id: "a", name: "Read", arguments: {} }, { id: "b", name: "Read", arguments: {} }] };
  const result: Message = { role: "user", content: "", toolResults: [{ toolUseId: "a", content: "a" }] };
  const encode = (value: Message) => JSON.stringify({ type: "message", ts, message: value });
  expect(rebuildHistory([line("question"), encode(call), encode(result), line("later")]).truncatedFrom).toBe(1);
  expect(rebuildHistory([line("question"), encode(result)]).truncatedFrom).toBe(1);
  result.toolResults!.push({ toolUseId: "b", content: "b" });
  expect(rebuildHistory([line("question"), encode(call), encode(result)]).messages).toHaveLength(3);
});

test("崩溃半行之后续写有独立换行，路径穿越不写入", () => {
  const id = newSessionId();
  f.write(join(sessionsDir(f.workDir), `${id}.jsonl`), line("first") + '\n{"type":');
  new SessionWriter(id, f.workDir).onAppend(message("second"));
  const result = rebuildHistory(readSessionLines(f.workDir, id));
  expect(result.skippedLines).toBe(1);
  expect(result.messages.map((m) => m.content)).toEqual(["first", "second"]);
  expect(() => readSessionLines(f.workDir, "../outside")).toThrow();
});

test("列表现算标题、数量、时间，倒序、排除当前且最多二十条", () => {
  for (let i = 0; i < 25; i++) {
    const id = `20261019-000000-${i.toString(16).padStart(4, "0")}`;
    f.write(join(sessionsDir(f.workDir), `${id}.jsonl`), line("首行\n" + "中".repeat(60), new Date(2026, 9, 19, 0, i).toISOString()) + "\nbad\n" + line("last", new Date(2026, 9, 19, 0, i, 1).toISOString()));
  }
  const list = listSessions(f.workDir, "20261019-000000-0018");
  expect(list).toHaveLength(20);
  expect(list[0]!.id).toBe("20261019-000000-0017");
  expect(list[0]!.title.length).toBe(50);
  expect(list[0]!.title).not.toContain("\n");
  expect(list[0]!.messageCount).toBe(2);
  expect(list[0]!.lastActive).toEqual(new Date(2026, 9, 19, 0, 23, 1));
  expect(readdirSync(sessionsDir(f.workDir)).every((name) => name.endsWith(".jsonl"))).toBe(true);
});

test("三十一天前的会话清理，二十九天前保留", () => {
  const now = new Date();
  for (const days of [29, 31]) {
    const path = join(sessionsDir(f.workDir), `20260901-000000-00${days}.jsonl`);
    f.write(path, line("old"));
    const date = new Date(now.getTime() - days * 86_400_000);
    utimesSync(path, date, date);
  }
  expect(cleanupExpiredSessions(f.workDir, now)).toBe(1);
  expect(readdirSync(sessionsDir(f.workDir))).toEqual(["20260901-000000-0029.jsonl"]);
});

test("被其他存活进程占用的会话标注使用中，超期也不清理；残留占用不算", () => {
  const now = new Date();
  const ids = ["20260901-000000-0aaa", "20260901-000000-0bbb"];
  for (const id of ids) {
    const path = join(sessionsDir(f.workDir), `${id}.jsonl`);
    f.write(path, line("old"));
    const date = new Date(now.getTime() - 31 * 86_400_000);
    utimesSync(path, date, date);
  }
  // 父进程模拟存活的另一实例；999999 模拟已崩溃的实例。
  f.write(sessionLockPath(f.workDir, ids[0]!), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
  f.write(sessionLockPath(f.workDir, ids[1]!), JSON.stringify({ pid: 999_999, ts: Date.now() }));
  const inUse = Object.fromEntries(listSessions(f.workDir).map((session) => [session.id, session.inUse]));
  expect(inUse).toEqual({ [ids[0]!]: true, [ids[1]!]: false });
  expect(cleanupExpiredSessions(f.workDir, now)).toBe(1);
  expect(readdirSync(sessionsDir(f.workDir))).toEqual([`${ids[0]}.jsonl`]);
});

test("display 字段随存档往返；类型不对的行按损坏跳过", () => {
  const ts = "2026-10-19T00:00:00Z";
  const rebuilt = rebuildHistory([
    JSON.stringify({ type: "message", ts, message: { role: "user", content: "展开文本", display: "/review" } }),
    JSON.stringify({ type: "message", ts, message: { role: "user", content: "坏行", display: 42 } }),
    line("旧记录"),
  ]);
  expect(rebuilt.messages).toEqual([{ role: "user", content: "展开文本", display: "/review" }, message("旧记录")]);
  expect(rebuilt.skippedLines).toBe(1);
});
