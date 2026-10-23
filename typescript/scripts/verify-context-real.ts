#!/usr/bin/env bun
/**
 * 用当前配置的真实 provider 验证上下文管理。运行：
 *   bun run scripts/verify-context-real.ts
 * 只写入系统临时目录，不打印配置、密钥或模型响应全文。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runLoop } from "../src/agent/loop.js";
import { getContextWindow, loadConfig } from "../src/config/config.js";
import { Compactor } from "../src/context/compactor.js";
import { TokenEstimator } from "../src/context/tokens.js";
import { ConversationManager } from "../src/conversation/conversation.js";
import { createClient } from "../src/llm/client.js";
import type { LLMClient } from "../src/llm/client.js";
import { buildSystemPrompt, detectEnvironment } from "../src/prompt/builder.js";
import { ReadTool } from "../src/tools/read.js";
import { ToolRegistry } from "../src/tools/registry.js";

const provider = loadConfig().providers[0]!;
const workDir = mkdtempSync(join(tmpdir(), "mewcode-context-smoke-"));
const readRegistry = new ToolRegistry().register(ReadTool);

async function makeClient(registry: ToolRegistry) {
  const segments = buildSystemPrompt(
    detectEnvironment(workDir, provider.model),
    { tools: registry.list().map((tool) => ({ name: tool.name, description: tool.description })) },
  );
  return createClient(provider, segments);
}

async function main(): Promise<void> {
  if (process.argv.includes("--circuit-only")) {
    const registry = new ToolRegistry();
    const realClient = await makeClient(registry);
    let rejectedSummaries = 0;
    const client: LLMClient = {
      stream(conversation, tools, options) {
        if (options?.reminders?.some((reminder) => reminder.includes("你是对话摘要生成器"))) {
          rejectedSummaries += 1;
          throw new Error("模拟摘要端点不可用");
        }
        return realClient.stream(conversation, tools, options);
      },
    };
    const conversation = new ConversationManager();
    for (let index = 0; index < 6; index += 1) {
      conversation.addUserMessage(`阶段 ${index + 1}：` + "abcd".repeat(375));
      conversation.addAssistantMessage(`已记录阶段 ${index + 1}。`);
    }
    conversation.addUserMessage("请只回答：主对话仍可用");
    const compactor = new Compactor(client, conversation, new TokenEstimator(), workDir, 15_000);
    await compactor.maintain();
    await compactor.maintain();
    let circuitNotice = "";
    let doneReason = "";
    let reply = "";
    for await (const event of runLoop({
      client, conversation, registry, protocol: provider.protocol,
      workDir, mode: "execute", compactor,
    })) {
      if (event.type === "notice" && event.text.includes("暂停自动压缩")) circuitNotice = event.text;
      if (event.type === "done") { doneReason = event.reason; reply = event.finalText; }
    }
    if (!circuitNotice || !compactor.circuitOpen || rejectedSummaries !== 3) {
      throw new Error("摘要失败后未正确熔断并提示");
    }
    if (doneReason !== "complete" || !reply) throw new Error("熔断后真实主对话未继续完成");
    console.log("熔断：成功，模拟摘要端点连续失败 3 次；真实主对话仍完成");
    return;
  }
  if (!process.argv.includes("--auto-only")) {
  const readClient = await makeClient(readRegistry);
  const fileLines = Array.from({ length: 12_001 }, (_unused, index) =>
    `record ${String(index + 1).padStart(5, "0")}: marker M-${String(index + 1).padStart(5, "0")} ${"x".repeat(32)}`,
  );
  writeFileSync(join(workDir, "big.txt"), fileLines.join("\n"));

  const readConversation = new ConversationManager();
  const readCompactor = new Compactor(
    readClient, readConversation, new TokenEstimator(), workDir, getContextWindow(provider),
  );
  readConversation.addUserMessage("请用 Read 工具读取 big.txt，从开头读取至少 1000 行，不指定 offset 或 limit。然后只回答文件总行数。");
  for await (const _event of runLoop({
    client: readClient, conversation: readConversation, registry: readRegistry,
    protocol: provider.protocol, workDir, mode: "execute", compactor: readCompactor,
  })) { /* 验证历史与存盘文件，不打印流式正文。 */ }

  const spilledResult = readConversation.getMessages()
    .flatMap((message) => message.toolResults ?? [])
    .find((result) => result.content.includes("完整输出已存盘"));
  if (!spilledResult) throw new Error("真实工具调用后未发现存盘预览");
  const spillDir = join(workDir, ".mewcode", "tool-outputs");
  const spillFiles = readdirSync(spillDir);
  if (spillFiles.length === 0) throw new Error("存盘目录为空");
  if (!spillFiles.some((name) => /^Read-\d{8}-\d{6}-[a-z0-9]+\.txt$/.test(name))) {
    throw new Error("存盘文件名未包含真实工具名 Read");
  }
  const saved = readFileSync(join(spillDir, spillFiles[0]!), "utf8");
  if (!saved.includes("M-00123")) throw new Error("存盘文件缺少原始行内容");
  console.log(`存盘：成功，${spillFiles.length} 个文件，预览 ${spilledResult.content.length} 字符`);

  readConversation.addUserMessage("请再次用 Read 工具读取 big.txt 的第 123 行（offset 122, limit 1），只回答那一行的 marker 值。");
  let recovered = "";
  for await (const event of runLoop({
    client: readClient, conversation: readConversation, registry: readRegistry,
    protocol: provider.protocol, workDir, mode: "execute", compactor: readCompactor,
  })) {
    if (event.type === "done") recovered = event.finalText;
  }
  if (!recovered.includes("M-00123")) throw new Error("后续对话未正确恢复文件细节");
  console.log("细节恢复：成功，真实模型读取第 123 行并给出正确 marker");
  }

  const plainRegistry = new ToolRegistry();
  const plainClient = await makeClient(plainRegistry);
  const conversation = new ConversationManager();
  for (let index = 0; index < 20; index += 1) {
    // 放在待摘要区的后段：即使摘要请求按 F10 截短，仍保留这个关键事实。
    const marker = index === 15 ? "项目代号 ALPHA-17。" : `阶段 ${index + 1} 已记录。`;
    conversation.addUserMessage(marker + "背景材料：" + "abcd".repeat(625));
    conversation.addAssistantMessage(`已记录阶段 ${index + 1}。`);
  }
  conversation.addUserMessage("请根据之前的内容回答项目代号。只回答代号。");
  const compactor = new Compactor(plainClient, conversation, new TokenEstimator(), workDir, 25_000);
  let autoNotice = "";
  let autoReply = "";
  for await (const event of runLoop({
    client: plainClient, conversation, registry: plainRegistry,
    protocol: provider.protocol, workDir, mode: "execute", compactor,
  })) {
    if (event.type === "compaction") autoNotice = event.text;
    if (event.type === "done") autoReply = event.finalText;
  }
  if (!autoNotice.includes("已压缩历史")) throw new Error("真实模型摘要后未发生自动压缩");
  if (!autoReply.includes("ALPHA-17")) throw new Error(`压缩后的模型回复未保留项目代号：${autoReply.slice(0, 200)}`);
  console.log("自动压缩：成功，模型经摘要记住历史项目代号并继续回复");

  conversation.addUserMessage("补充：下一步需要核对验收清单。");
  conversation.addAssistantMessage("已记录下一步。");
  const firstManual = await compactor.compactManually();
  if (!firstManual.compacted) throw new Error(`首次 /compact 失败：${firstManual.error ?? "历史不足"}`);
  conversation.addUserMessage("再补充：验收时记录测试数量。");
  conversation.addAssistantMessage("已记录数量要求。");
  const secondManual = await compactor.compactManually();
  if (!secondManual.compacted) throw new Error(`再次 /compact 失败：${secondManual.error ?? "历史不足"}`);
  console.log("手动压缩：成功，同一会话连续两次调用均完成");
}

try {
  await main();
} finally {
  const resolved = realpathSync(workDir);
  if (dirname(resolved) !== realpathSync(tmpdir()) || !basename(resolved).startsWith("mewcode-context-smoke-")) {
    throw new Error(`拒绝清理非预期目录：${resolved}`);
  }
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}
