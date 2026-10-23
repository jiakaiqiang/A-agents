import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { render } from "ink";
import { App } from "../../../src/tui/app.js";
import { createDefaultRegistry } from "../../../src/tools/index.js";
import { newSessionId, SessionWriter, listSessions, readSessionLines, rebuildHistory, sessionsDir } from "../../../src/memory/session.js";
import { sessionLockPath } from "../../../src/memory/lock.js";
import { MemoryStore, memoryDir } from "../../../src/memory/notes.js";
import { fixture } from "../helpers.js";

const f = fixture();
let output = "";
let releaseAgent: (() => void) | undefined;
let releaseMemory: (() => void) | undefined;
let holdMemory = false;
let memoryRequests = 0;
const requests: { system: string; text: string; messages: { role: string; content: string }[] }[] = [];

async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 7000) throw new Error(`超时：${label}\n${output.slice(-3500)}`);
    await Bun.sleep(20);
  }
}

function sse(text: string, hold: "agent" | "memory" | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    if (hold === "agent") send({ choices: [{ index: 0, delta: { content: "WAITING_MARKER" } }] });
    const finish = () => {
      try {
        send({ choices: [{ index: 0, delta: { content: text } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch { /* 取消后客户端连接可能已经关闭。 */ }
    };
    if (hold === "agent") releaseAgent = finish;
    else if (hold === "memory") releaseMemory = finish;
    else finish();
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const body = await request.json() as { messages: { role: string; content: string }[]; tools?: unknown[] };
  const isMemory = body.messages.some((message) => message.content?.includes("你是记忆整理器"));
  if (isMemory) {
    memoryRequests++;
    assert.equal(body.tools, undefined);
    return sse(JSON.stringify({ operations: [{ op: "upsert", scope: "user", name: "prefers-short", description: "用户偏好简短回答", type: "user", body: "控制在三句话以内。" }] }), holdMemory ? "memory" : null);
  }
  const text = [...body.messages].reverse().find((message) => message.role === "user" && /^(slow|recall|exit-test)/.test(message.content))?.content ?? "";
  requests.push({ system: body.messages[0]!.content, text, messages: body.messages });
  return sse(text === "recall" ? "ANSWER_42" : "ANSWER_DONE", text.startsWith("slow") ? "agent" : null);
} });

const stdout = new PassThrough();
stdout.on("data", (chunk) => { output += chunk.toString(); });
Object.assign(stdout, { columns: 100, rows: 35 });
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
const instance = render(<App
  providers={[{ name: "test", protocol: "openai-compat", base_url: `http://127.0.0.1:${server.port}/v1`, model: "test", api_key: "test", context_window: 128_000 }]}
  hooks={[]} registry={createDefaultRegistry()} workDir={f.workDir} homeDir={f.homeDir}
  startup={{ instructions: "STARTUP_RULE", memory: "STARTUP_MEMORY", warnings: [] }}
/>, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false });

async function send(text: string): Promise<void> { stdin.write(text); await Bun.sleep(35); stdin.write("\r"); await Bun.sleep(60); }

try {
  await Bun.sleep(300);
  await send("/resume");
  await until(() => output.includes("暂无历史会话"), "无历史会话提示");
  await send("slow-empty");
  await until(() => requests.length === 1 && !!releaseAgent, "首个运行中请求");
  await send("/resume");
  assert(!output.includes("本轮已中断"));
  releaseAgent!(); releaseAgent = undefined;
  await until(() => output.includes("已更新记忆"), "后台更新提示");
  const current = listSessions(f.workDir)[0]!;
  const before = readSessionLines(f.workDir, current.id).length;
  const otherId = newSessionId(new Date(2026, 9, 18));
  const writer = new SessionWriter(otherId, f.workDir);
  writer.onAppend({ role: "user", content: "记住数字 42" });
  writer.onAppend({ role: "assistant", content: "已记住" });
  // 并发保护（F15）：父进程（bun test）模拟另一个存活实例，占用一份更早的会话。
  const busyId = "20261001-000000-0b5e";
  f.write(join(sessionsDir(f.workDir), `${busyId}.jsonl`), JSON.stringify({ type: "message", ts: "2026-10-01T00:00:00.000Z", message: { role: "user", content: "busy-session" } }) + "\n");
  f.write(sessionLockPath(f.workDir, busyId), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
  await send("/resume");
  await until(() => output.includes("恢复历史会话"), "恢复选择界面");
  await until(() => output.includes("· 使用中"), "被占用会话标注");
  stdin.write("\u001b"); await Bun.sleep(80);
  assert.equal(readSessionLines(f.workDir, current.id).length, before);
  const reopen = output.length;
  await send("/resume");
  await until(() => output.slice(reopen).includes("恢复历史会话"), "再次打开选择界面");
  stdin.write("\u001b[B"); await Bun.sleep(60); stdin.write("\r");
  await until(() => output.includes("该会话正在被另一个 MewCode 使用"), "被占用会话拒绝恢复");
  assert.equal(readSessionLines(f.workDir, current.id).length, before);
  assert(!output.includes(`已恢复会话 ${busyId}`));
  assert.equal(JSON.parse(readFileSync(sessionLockPath(f.workDir, current.id), "utf8")).pid, process.pid);
  await send("slow-existing");
  await until(() => requests.length === 2 && !!releaseAgent, "第二个运行中请求");
  await send("keep-this");
  await until(() => output.includes("仅支持 /resume"), "运行中拒绝提示");
  const mark = output.length;
  stdin.write("\u0001"); await Bun.sleep(35); stdin.write("X"); await Bun.sleep(100);
  assert(stripVTControlCharacters(output.slice(mark)).replaceAll("▌", "").includes("Xkeep-this"), "被拒内容应保留并可继续编辑");
  for (let i = 0; i < "Xkeep-this".length; i++) { stdin.write("\u001b[C"); await Bun.sleep(5); }
  for (let i = 0; i < "Xkeep-this".length; i++) { stdin.write("\u007f"); await Bun.sleep(5); }
  const updatesBeforeCancel = memoryRequests;
  await send("/resume");
  await until(() => output.includes("本轮已中断"), "取消后收尾");
  await Bun.sleep(100);
  assert.equal(memoryRequests, updatesBeforeCancel);
  stdin.write("\r");
  await until(() => output.includes(`已恢复会话 ${otherId}`), "恢复完成");
  // 换锁：占用目标会话，释放原会话。
  assert.equal(JSON.parse(readFileSync(sessionLockPath(f.workDir, otherId), "utf8")).pid, process.pid);
  assert(!existsSync(sessionLockPath(f.workDir, current.id)));
  await send("recall");
  await until(() => output.includes("ANSWER_42"), "恢复后追问");
  assert(requests.at(-1)!.messages.some((message) => message.content === "记住数字 42"));
  assert(readSessionLines(f.workDir, otherId).length >= 4);
  assert.equal(new Set(requests.map((request) => request.system)).size, 1);
  assert(requests[0]!.system.includes("STARTUP_RULE") && requests[0]!.system.includes("STARTUP_MEMORY"));
  assert(!requests.at(-1)!.system.includes("prefers-short.md"));
  assert(new MemoryStore(memoryDir("user", f.workDir, f.homeDir)).read("prefers-short"));
  assert.equal(rebuildHistory(readSessionLines(f.workDir, otherId)).truncatedFrom, null);
  holdMemory = true;
  await send("exit-test");
  await until(() => !!releaseMemory, "退出前后台请求");
  const start = Date.now();
  let exited = false;
  void instance.waitUntilExit().then(() => { exited = true; });
  await send("/exit");
  await until(() => exited, "退出不等待后台更新");
  assert(Date.now() - start < 1000);
  await until(() => !existsSync(sessionLockPath(f.workDir, otherId)), "退出释放会话占用");
  assert(existsSync(sessionLockPath(f.workDir, busyId)), "别的实例的占用不能被删");
  console.log("TUI_MEMORY_OK");
} finally {
  instance.unmount();
  releaseAgent?.(); releaseMemory?.();
  server.stop(true); stdin.destroy(); stdout.destroy(); f.cleanup();
}
