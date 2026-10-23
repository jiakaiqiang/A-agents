import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, StopReason } from "../../src/agent/events.js";
import type { LLMClient } from "../../src/llm/client.js";
import { emptyUsage, type StreamEvent } from "../../src/llm/events.js";
import { MemoryStore, memoryDir, type Note } from "../../src/memory/notes.js";
import { applyOperations, buildUpdatePrompt, MemoryUpdater, parseOperations, TurnCollector, type TurnDigest } from "../../src/memory/updater.js";
import { fixture, textClient } from "./helpers.js";

let f: ReturnType<typeof fixture>;
let stores: Record<"user" | "project", MemoryStore>;
beforeEach(() => {
  f = fixture();
  stores = { user: new MemoryStore(memoryDir("user", f.workDir, f.homeDir)), project: new MemoryStore(memoryDir("project", f.workDir, f.homeDir)) };
});
afterEach(() => f.cleanup());
const note: Note = { name: "prefers-chinese", description: "用户偏好中文", type: "user", body: "这是用户明确要求。" };
const digest: TurnDigest = { userText: "记住我偏好中文", assistantTexts: ["记住了"], toolNames: ["Read"] };
const response = JSON.stringify({ operations: [{ op: "upsert", scope: "user", ...note }] });
const end: StreamEvent = { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() };

test("只有自然完成可生成摘要，工具结果与思考块不进入请求", () => {
  for (const reason of ["complete", "cancelled", "stream_error", "max_iterations", "invalid_tools"] as StopReason[]) {
    const collector = new TurnCollector("input");
    const events: AgentEvent[] = [
      { type: "text", text: "先" }, { type: "text", text: "检查" },
      { type: "tool_start", toolId: "a", name: "Read", argSummary: "args" },
      { type: "tool_output", toolId: "a", content: "SECRET_TOOL_RESULT" },
      { type: "thinking", text: "SECRET_THINKING" },
      { type: "tool_start", toolId: "b", name: "Read", argSummary: "args" },
      { type: "text", text: "完成" },
      { type: "done", reason, iterations: 2, toolsExecuted: 2, finalText: "完成" },
    ];
    events.forEach((event) => collector.observe(event));
    expect(collector.digest()).toEqual(reason === "complete" ? { userText: "input", assistantTexts: ["先检查", "完成"], toolNames: ["Read"] } : null);
  }
});

test("提示词含全部记忆规则、索引原文及当前行数体积", () => {
  const prompt = buildUpdatePrompt(digest, "用户索引\n", "项目索引\n第二行\n");
  expect(prompt.system).toContain("禁止调用工具");
  for (const text of ["用户偏好", "纠正反馈", "项目知识", "参考资料", "去重", "敏感值", "超限", "无变更", "当前 1 行", "当前 2 行", "25000", "用户索引", "项目索引", "记住我偏好中文", "Read"]) expect(prompt.user).toContain(text);
});

test("模型输出整批校验，合法围栏、空数组、无变更可解析", () => {
  expect(parseOperations("```json\n" + response + "\n```")).toEqual([{ op: "upsert", scope: "user", note }]);
  expect(parseOperations("无变更")).toEqual([]);
  expect(parseOperations('{"operations":[]}')).toEqual([]);
  for (const raw of ["not-json", "{}", '{"operations":null}', response.replace("prefers-chinese", "../outside"), response.replace('"user"', '"invalid"'), response.replace('"type":"user"', '"type":"constructor"')]) expect(parseOperations(raw)).toBeNull();
  const mixed = JSON.stringify({ operations: [{ op: "upsert", scope: "user", ...note }, { op: "delete", scope: "project", name: "../bad" }] });
  expect(parseOperations(mixed)).toBeNull();
});

test("新增、同名更新、删除同步维护索引，无变更不触碰文件时间", () => {
  expect(applyOperations(parseOperations(response)!, stores)).toEqual([note.name]);
  const path = join(stores.user.dir, "MEMORY.md");
  const before = statSync(path).mtimeMs;
  expect(applyOperations(parseOperations(response)!, stores)).toEqual([]);
  expect(statSync(path).mtimeMs).toBe(before);
  applyOperations([{ op: "upsert", scope: "user", note: { ...note, description: "用户偏好简短中文" } }], stores);
  expect(stores.user.readIndex()).toContain("用户偏好简短中文");
  expect(readdirSync(stores.user.dir)).toHaveLength(2);
  expect(applyOperations([{ op: "delete", scope: "user", name: note.name }, { op: "delete", scope: "project", name: "missing" }], stores)).toEqual([note.name]);
  expect(stores.user.readIndex()).toBe("");
});

test("后台请求禁工具、含提醒；成功才通知，无变更不创建目录", async () => {
  const notifications: string[][] = [];
  const client: LLMClient = { async *stream(conversation, tools, options) {
    expect(tools).toEqual([]);
    expect(options?.reminders?.join()).toContain("禁止调用工具");
    expect(conversation.getMessages()[0]!.content).toContain(digest.userText);
    yield* textClient(response).stream(conversation, tools, options);
  } };
  const updater = new MemoryUpdater(client, stores, (names) => notifications.push(names));
  updater.enqueue(digest);
  await updater.idle();
  expect(stores.user.read(note.name)).toEqual(note);
  expect(notifications).toEqual([[note.name]]);
  const noop = new MemoryUpdater(textClient('{"operations":[]}'), stores, (names) => notifications.push(names));
  noop.enqueue(digest); await noop.idle();
  expect(notifications).toHaveLength(1);
  expect(existsSync(stores.project.dir)).toBe(false);
});

test("队列串行且第二轮读取第一轮更新后的索引", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let active = 0;
  const client: LLMClient = { async *stream(conversation) {
    expect(active).toBe(0); active++;
    calls++;
    if (calls === 1) await gate;
    else expect(conversation.getMessages()[0]!.content).toContain("prefers-chinese.md");
    yield { type: "text_delta", text: calls === 1 ? response : '{"operations":[]}' };
    yield end;
    active--;
  } };
  const updater = new MemoryUpdater(client, stores);
  updater.enqueue(digest); updater.enqueue(digest);
  await Promise.resolve();
  expect(calls).toBe(1);
  release(); await updater.idle();
  expect(calls).toBe(2);
});

test("模型错误或非法输出静默，后续队列继续执行", async () => {
  let calls = 0;
  const notifications: string[][] = [];
  const client: LLMClient = { async *stream() {
    calls++;
    if (calls === 1) throw new Error("offline");
    yield { type: "text_delta", text: calls === 2 ? response.replace("prefers-chinese", "../bad") : response };
    yield end;
  } };
  const updater = new MemoryUpdater(client, stores, (names) => notifications.push(names));
  for (let i = 0; i < 3; i++) updater.enqueue(digest);
  await updater.idle();
  expect(calls).toBe(3);
  expect(notifications).toEqual([[note.name]]);
});

test("写入失败静默且不通知", async () => {
  f.write(stores.user.dir, "not-a-directory");
  const updater = new MemoryUpdater(textClient(response), stores, () => { throw new Error("不该通知"); });
  updater.enqueue(digest); await updater.idle();
  expect(stores.user.read(note.name)).toBeNull();
});

test("退出中止当前与排队任务，不等不响应 signal 的客户端，迟到结果不能落盘", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const client: LLMClient = { async *stream() {
    calls++; await gate;
    yield { type: "text_delta", text: response }; yield end;
  } };
  const updater = new MemoryUpdater(client, stores);
  updater.enqueue(digest); updater.enqueue(digest);
  await Promise.resolve();
  updater.abort(); await updater.idle();
  expect(calls).toBe(1);
  release(); await Promise.resolve(); await Promise.resolve();
  expect(existsSync(stores.user.dir)).toBe(false);
});

test("流中断、截断或意外工具调用不能写入笔记", async () => {
  for (const events of [
    [{ type: "text_delta", text: response }],
    [{ type: "text_delta", text: response }, { ...end, stopReason: "length" }],
    [{ type: "tool_call_start", toolId: "t", toolName: "Read" }, { type: "text_delta", text: response }, end],
  ] as StreamEvent[][]) {
    const updater = new MemoryUpdater({ async *stream() { yield* events; } }, stores);
    updater.enqueue(digest); await updater.idle();
    expect(existsSync(stores.user.dir)).toBe(false);
  }
});

// ── 并发保护（F16）：另一实例用「直接改目录 / 手写锁文件」模拟 ──
const projectNote: Note = { name: "uses-bun-test", description: "本项目用 bun test 跑测试", type: "project", body: "命令：bun test" };
const otherNote: Note = { name: "from-other-instance", description: "另一实例写入的项目知识", type: "project", body: "其他实例" };
const projectResponse = (n: Note) => JSON.stringify({ operations: [{ op: "upsert", scope: "project", ...n }] });
const lockOf = (scope: "user" | "project") => stores[scope].lockPath;

test("写入前发现目录被另一实例改过：本批不落盘，用最新索引重跑一次", async () => {
  const prompts: string[] = [];
  const client: LLMClient = { async *stream(conversation) {
    prompts.push(conversation.getMessages()[0]!.content);
    if (prompts.length === 1) { stores.project.write(otherNote); stores.project.rebuildIndex(); }
    yield { type: "text_delta", text: projectResponse(prompts.length === 1 ? { ...projectNote, body: "第一批" } : projectNote) };
    yield end;
  } };
  const notifications: string[][] = [];
  const updater = new MemoryUpdater(client, stores, (names) => notifications.push(names));
  updater.enqueue(digest); await updater.idle();
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).not.toContain("from-other-instance.md");
  expect(prompts[1]).toContain("from-other-instance.md");
  expect(stores.project.read(projectNote.name)).toEqual(projectNote); // 第二批生效，第一批的「第一批」正文未落盘
  expect(stores.project.read(otherNote.name)).toEqual(otherNote);
  expect(notifications).toEqual([[projectNote.name]]);
  expect(existsSync(lockOf("project"))).toBe(false);
});

test("重跑后仍冲突则放弃，只保留另一实例的写入", async () => {
  let calls = 0;
  const client: LLMClient = { async *stream() {
    calls++;
    stores.project.write({ ...otherNote, body: `第 ${calls} 次修改` });
    yield { type: "text_delta", text: projectResponse(projectNote) };
    yield end;
  } };
  const updater = new MemoryUpdater(client, stores, () => { throw new Error("不该通知"); });
  updater.enqueue(digest); await updater.idle();
  expect(calls).toBe(2);
  expect(stores.project.read(projectNote.name)).toBeNull();
  expect(stores.project.read(otherNote.name)?.body).toBe("第 2 次修改");
});

test("记忆锁被存活的其他进程持有：等待超时后放弃，无写入、无临时文件残留", async () => {
  f.write(lockOf("project"), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
  const started = Date.now();
  const updater = new MemoryUpdater(textClient(projectResponse(projectNote)), stores, () => { throw new Error("不该通知"); }, 200);
  updater.enqueue(digest); await updater.idle();
  expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  expect(existsSync(stores.project.dir)).toBe(false);
  expect(JSON.parse(readFileSync(lockOf("project"), "utf8")).pid).toBe(process.ppid); // 别人的锁原样保留
});

test("残留的记忆锁（持有进程已不存在、或超过 30 秒）不阻塞写入，写完锁已释放", async () => {
  for (const record of [{ pid: 999_999, ts: Date.now() }, { pid: process.ppid, ts: Date.now() - 60_000 }]) {
    f.write(lockOf("project"), JSON.stringify(record));
    const updater = new MemoryUpdater(textClient(projectResponse(projectNote)), stores, undefined, 200);
    updater.enqueue(digest); await updater.idle();
    expect(stores.project.read(projectNote.name)).toEqual(projectNote);
    expect(existsSync(lockOf("project"))).toBe(false);
    stores.project.delete(projectNote.name);
  }
});

test("两个范围都写时按 user → project 加锁；project 锁被占则整批放弃，user 锁也已释放", async () => {
  f.write(lockOf("project"), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
  const both = JSON.stringify({ operations: [{ op: "upsert", scope: "user", ...note }, { op: "upsert", scope: "project", ...projectNote }] });
  const updater = new MemoryUpdater(textClient(both), stores, undefined, 150);
  updater.enqueue(digest); await updater.idle();
  expect(stores.user.read(note.name)).toBeNull();
  expect(existsSync(lockOf("user"))).toBe(false);
  expect(readdirSync(join(f.homeDir, ".mewcode")).includes("memory")).toBe(false);
});
