#!/usr/bin/env bun
/** 使用已配置的真实 provider 验证记忆流程；数据只写临时项目与临时用户目录。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.js";
import { ConversationManager } from "../src/conversation/conversation.js";
import { createClient, type LLMClient } from "../src/llm/client.js";
import { runLoop } from "../src/agent/loop.js";
import { loadInstructions } from "../src/memory/instructions.js";
import { loadMemorySnapshot, MemoryStore, memoryDir } from "../src/memory/notes.js";
import { resumeSession } from "../src/memory/resume.js";
import { newSessionId, readSessionLines, rebuildHistory, SessionWriter, sessionsDir } from "../src/memory/session.js";
import { MemoryUpdater, TurnCollector } from "../src/memory/updater.js";
import { buildSystemPrompt, detectEnvironment } from "../src/prompt/builder.js";
import { ReadTool } from "../src/tools/read.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = mkdtempSync(join(tmpdir(), "mewcode-memory-real-"));
const workDir = join(root, "project");
const homeDir = join(root, "home");
mkdirSync(join(workDir, "docs"), { recursive: true });
mkdirSync(homeDir);
const provider = loadConfig().providers[0]!;
const registry = new ToolRegistry().register(ReadTool);
const stores = { user: new MemoryStore(memoryDir("user", workDir, homeDir)), project: new MemoryStore(memoryDir("project", workDir, homeDir)) };
const updates: string[] = [];
let updater: MemoryUpdater | undefined;

async function makeClient(): Promise<{ client: LLMClient; stable: string }> {
  const instructions = loadInstructions(workDir, homeDir);
  assert.equal(instructions.warnings.length, 0);
  const segments = buildSystemPrompt(detectEnvironment(workDir, provider.model), {
    tools: registry.list().map((tool) => ({ name: tool.name, description: tool.description })),
    customInstructions: instructions.text, memory: loadMemorySnapshot(workDir, homeDir),
  });
  const real = await createClient(provider, segments);
  return { stable: segments.stable, client: { stream(conversation, tools, options) {
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(options?.signal ? [options.signal] : [])]);
    return real.stream(conversation, tools, { ...options, signal });
  } } };
}

async function turn(client: LLMClient, conversation: ConversationManager, text: string, update?: MemoryUpdater) {
  conversation.addUserMessage(text);
  const collector = new TurnCollector(text);
  let reply = "";
  let tools = 0;
  for await (const event of runLoop({ client, conversation, registry, protocol: provider.protocol, workDir, mode: "execute", maxIterations: 5, signal: AbortSignal.timeout(90_000) })) {
    collector.observe(event);
    if (event.type === "done") { assert.equal(event.reason, "complete", event.errorMessage ?? event.reason); reply = event.finalText; tools = event.toolsExecuted; }
  }
  const digest = collector.digest();
  if (digest && update) { update.enqueue(digest); await update.idle(); }
  return { reply, tools };
}

try {
  writeFileSync(join(workDir, "MEWCODE.md"), "所有面向用户的回答末尾增加一行：— MewCode\n@docs/rules.md\n@Override\n");
  writeFileSync(join(workDir, "docs/rules.md"), "本项目变量命名规则为 snake_case。\n");
  writeFileSync(join(workDir, "sample.txt"), "本次测试的会话数字是 42。\n");
  const first = await makeClient();
  const conversation = new ConversationManager();
  const id = newSessionId();
  conversation.setRecorder(new SessionWriter(id, workDir));
  updater = new MemoryUpdater(first.client, stores, (names) => updates.push(...names));
  const read = await turn(first.client, conversation, "请调用 Read 读取 sample.txt，回答文件中的会话数字以及项目变量命名规则。", updater);
  assert(read.tools > 0);
  assert(read.reply.includes("42") && read.reply.includes("snake_case") && read.reply.includes("MewCode"));
  assert.equal(rebuildHistory(readSessionLines(workDir, id)).truncatedFrom, null);
  console.log("PASS 指令引用、真实工具调用与完整会话存档");

  await turn(first.client, conversation, "这是我的长期偏好，请在未来所有会话里记住：使用中文回答，尽量控制在三句话以内。", updater);
  assert(updates.length > 0 && stores.user.list().some((note) => /三句|中文/.test(note.description + note.body)));
  console.log("PASS 真实模型后台生成用户笔记与索引");

  writeFileSync(join(workDir, "MEWCODE.md"), "@docs/rules.md\n");
  const same = await turn(first.client, conversation, "请简短回答：本项目变量命名规则是什么？");
  assert(same.reply.includes("MewCode"));
  assert(!first.stable.includes(stores.user.list()[0]!.name + ".md"));
  const next = await makeClient();
  assert(!next.stable.includes("所有面向用户的回答末尾增加"));
  assert(next.stable.includes("## 用户级记忆"));
  const fresh = new ConversationManager();
  const preference = await turn(next.client, fresh, "我之前要求你使用什么语言回答，以及回答长度偏好是什么？");
  assert(preference.reply.includes("中文") && /三|3/.test(preference.reply));
  console.log("PASS 会话内提示词快照不变、新会话加载笔记");

  const restored = new ConversationManager();
  const before = readFileSync(join(sessionsDir(workDir), `${id}.jsonl`), "utf8");
  await resumeSession({ workDir, id, conversation: restored, writer: new SessionWriter(id, workDir) });
  const recall = await turn(next.client, restored, "刚才 sample.txt 中的会话数字是多少？直接从对话中回答即可。");
  assert(recall.reply.includes("42"));
  assert(readFileSync(join(sessionsDir(workDir), `${id}.jsonl`), "utf8").startsWith(before));
  assert.equal(rebuildHistory(readSessionLines(workDir, id)).truncatedFrom, null);
  console.log("PASS 真实模型恢复后追问与原档续写");
} finally {
  updater?.abort();
  rmSync(root, { recursive: true, force: true });
}
