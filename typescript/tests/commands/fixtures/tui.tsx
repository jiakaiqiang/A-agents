// 斜杠命令系统的真实 Ink 端到端驱动：假 SSE provider + PassThrough 终端。
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink";
import { App } from "../../../src/tui/app.js";
import { createDefaultRegistry } from "../../../src/tools/index.js";
import { createBuiltinRegistry } from "../../../src/commands/builtins/index.js";
import { bootstrapSkills } from "../../../src/commands/builtins/skills.js";
import { readFileSync } from "node:fs";
import { builtinSkillsDir } from "../../../src/skills/loader.js";
import { fixture } from "../../memory/helpers.js";

const f = fixture();
let output = "";
let releaseAgent: (() => void) | undefined;
// 只记录主对话请求；后台记忆整理请求单独计数，避免干扰「命令不发请求」的断言。
const requests: { raw: string; messages: { role: string; content: string }[] }[] = [];
const rawBodies: string[] = [];
// review Skill 正文第一行，用来断言对话区不显示 SOP 全文（Skill spec F9）。
const TEMPLATE_HEAD = readFileSync(`${builtinSkillsDir()}/review.md`, "utf8").split(/\r?\n---\r?\n/)[1]!.trim().split(/\r?\n/)[0]!;

const plain = () => stripVTControlCharacters(output).replaceAll("▌", "");
const since = (mark: number) => stripVTControlCharacters(output.slice(mark)).replaceAll("▌", "");

async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 7000) throw new Error(`超时：${label}\n${plain().slice(-3000)}`);
    await Bun.sleep(20);
  }
}

function sse(text: string, hold: boolean): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    const finish = () => {
      try {
        send({ choices: [{ index: 0, delta: { content: text } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch { /* 中断后连接可能已关闭。 */ }
    };
    if (hold) {
      send({ choices: [{ index: 0, delta: { content: "WAITING_MARKER" } }] });
      releaseAgent = finish;
    } else finish();
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const raw = await request.text();
  rawBodies.push(raw);
  const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
  if (body.messages.some((message) => message.content?.includes("你是记忆整理器"))) return sse(JSON.stringify({ operations: [] }), false);
  requests.push({ raw, messages: body.messages });
  const last = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  return sse("ANSWER_DONE", last.startsWith("slow"));
} });

const stdout = new PassThrough();
stdout.on("data", (chunk) => { output += chunk.toString(); });
Object.assign(stdout, { columns: 120, rows: 40 });
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
// 与 main.tsx 走同一段装配：内置命令 + Skill（/review 由 review Skill 承担）。
const registry = createDefaultRegistry();
const commands = createBuiltinRegistry();
const booted = bootstrapSkills({ registry, commands, workDir: f.workDir, homeDir: f.homeDir });
const instance = render(<App
  providers={[{ name: "test", protocol: "openai-compat", base_url: `http://127.0.0.1:${server.port}/v1`, model: "test", api_key: "test", context_window: 128_000 }]}
  hooks={[]} registry={registry} commands={commands} skills={booted.manager}
  skillReport={{ warnings: booted.warnings, summary: booted.summary }} workDir={f.workDir} homeDir={f.homeDir}
/>, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false });

const type = async (text: string) => { stdin.write(text); await Bun.sleep(60); };
const press = async (key: string) => { stdin.write(key); await Bun.sleep(80); };
const send = async (text: string) => { await type(text); await press("\r"); };
const clearLine = async (count: number) => { for (let i = 0; i < count; i++) { stdin.write("\u007f"); await Bun.sleep(5); } await Bun.sleep(40); };
const KEY = { up: "\u001b[A", down: "\u001b[B", tab: "\t", shiftTab: "\u001b[Z", esc: "\u001b" };

try {
  await Bun.sleep(300);
  // —— 状态栏档位标签（AC14）：命令与 Shift+Tab 走同一入口 ——
  await until(() => plain().includes("[DEFAULT]"), "启动显示 [DEFAULT]");
  let mark = output.length;
  await press(KEY.shiftTab);
  await until(() => since(mark).includes("[ACCEPT-EDITS]"), "Shift+Tab → [ACCEPT-EDITS]");
  for (const [command, tag] of [["/bypass", "[BYPASS]"], ["/plan", "[PLAN]"], ["/do", "[DEFAULT]"]] as const) {
    mark = output.length;
    await send(command);
    await until(() => since(mark).includes(tag), `${command} → ${tag}`);
  }

  // —— 实时补全：前缀匹配、↓ 高亮、Tab 填入、Enter 执行（AC15、AC16） ——
  mark = output.length;
  await type("/s");
  await until(() => since(mark).includes("❯ /session") && since(mark).includes("/skills") && since(mark).includes("/status"), "/s 列出 session、skills 与 status");
  mark = output.length;
  // 字母序 session → skills → status：↓ 两次到 /status。
  await press(KEY.down);
  await until(() => since(mark).includes("❯ /skills"), "↓ 高亮 /skills");
  mark = output.length;
  await press(KEY.down);
  await until(() => since(mark).includes("❯ /status"), "↓ 高亮 /status");
  mark = output.length;
  await press(KEY.tab);
  await until(() => since(mark).includes("❯ /status "), "Tab 填入「/status 」");
  await Bun.sleep(100);
  // 列表项也形如「❯ /status  描述」，所以要确认重绘后的帧里描述与执行结果都不在：列表已收起且未执行。
  assert(!since(mark).includes("查看 provider") && !since(mark).includes("Provider："), "Tab 只填入并收起列表，不执行");
  mark = output.length;
  await press("\r");
  await until(() => since(mark).includes("MCP 0/0 已连接"), "回车执行 /status");

  // —— 别名命中、Esc 收起并保留输入（AC16、AC17） ——
  mark = output.length;
  await type("/qu");
  await until(() => since(mark).includes("❯ /exit"), "/qu 经别名列出 /exit");
  await press(KEY.esc);
  await send("x");
  await until(() => plain().includes("未知命令：/qux"), "Esc 后输入保留为 /qux");

  // —— 未知命令不发请求；命令进 ↑ 历史（AC5、AC7） ——
  assert.equal(requests.length, 0, "以上命令都不应触发模型请求");
  mark = output.length;
  await press(KEY.up);
  await until(() => since(mark).includes("❯ /qux"), "↑ 翻出上一条命令");
  await press("\u0005");
  await clearLine(4);

  // —— 运行中：Esc 只收起列表、不可用命令被拒、只读命令照常（AC11、AC16） ——
  await send("slow-1");
  await until(() => !!releaseAgent, "运行中请求挂起");
  mark = output.length;
  await type("/s");
  await until(() => since(mark).includes("❯ /session"), "运行中也弹出补全");
  await press(KEY.esc);
  await Bun.sleep(150);
  assert(!since(mark).includes("本轮已中断"), "Esc 收起列表时不应中断本轮");
  await clearLine(2);
  await send("/clear");
  await until(() => plain().includes("Agent 运行中，请稍后或按 Esc 中断"), "运行中 /clear 被拒");
  await press("\u0005");
  await clearLine(6);
  mark = output.length;
  await send("/status");
  await until(() => since(mark).includes("MCP 0/0 已连接"), "运行中 /status 照常执行");
  releaseAgent!(); releaseAgent = undefined;
  await until(() => plain().includes("ANSWER_DONE"), "放行后本轮完成");
  await Bun.sleep(150);

  // —— /review 现由 review Skill 承担：对话区显示原命令，SOP 钉在 system 段，用户消息是触发语（Skill AC10、AC16） ——
  mark = output.length;
  await send("/review src/tui");
  await until(() => requests.length === 2 && since(mark).includes("ANSWER_DONE"), "/review 发起一轮");
  const reviewSystem = requests[1]!.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert(reviewSystem.includes("git diff") && reviewSystem.includes("审查范围：src/tui"), "SOP 与审查范围钉在 system 段");
  const reviewUser = requests[1]!.messages.filter((message) => message.role === "user").at(-1)!.content;
  assert(reviewUser.startsWith("执行 Skill review，参数：src/tui"), `用户消息是触发语，实际：${reviewUser}`);
  assert(!since(mark).includes(TEMPLATE_HEAD), "对话区不显示 SOP 全文");
  await Bun.sleep(150);

  // —— /clear：清空历史、换新会话（AC18） ——
  mark = output.length;
  await send("/session");
  await until(() => since(mark).includes("会话 ID："), "/session 输出");
  const oldId = /会话 ID：(\S+)/.exec(since(mark))![1]!;
  mark = output.length;
  await send("/clear");
  await until(() => since(mark).includes("已清空对话，开始新会话"), "/clear 提示");
  const newId = /开始新会话 (\S+?)（/.exec(since(mark))![1]!;
  assert.notEqual(newId, oldId, "/clear 后会话 ID 改变");
  assert(since(mark).includes("MewCode v0.1.0"), "清屏后横幅重新输出");
  mark = output.length;
  await send("hi");
  await until(() => requests.length === 3 && since(mark).includes("ANSWER_DONE"), "/clear 后对话");
  const afterClear = requests[2]!.messages.map((message) => message.content).join("\n");
  assert(!afterClear.includes("审查范围") && !afterClear.includes("slow-1"), "清空前的历史与已激活 Skill 都不再发给模型");
  await Bun.sleep(150);

  // —— /resume 回旧会话：显示原命令，模型历史仍是展开文本（AC9、AC18） ——
  mark = output.length;
  await send("/resume");
  await until(() => since(mark).includes("恢复历史会话"), "打开恢复列表");
  await press("\r");
  await until(() => plain().includes(`已恢复会话 ${oldId}`), "恢复旧会话");
  const restored = since(mark);
  assert(restored.includes("/review src/tui"), "恢复后显示原命令");
  assert(!restored.includes(TEMPLATE_HEAD), "恢复后不显示模板全文");
  mark = output.length;
  await send("recall");
  await until(() => requests.length === 4 && since(mark).includes("ANSWER_DONE"), "恢复后追问");
  assert(requests[3]!.messages.some((message) => message.content.startsWith("执行 Skill review，参数：src/tui")), "恢复后模型历史仍是发给模型的触发语");
  // 激活状态不存档：恢复后 review 的 SOP 不再钉在 system 段（Skill AC15）。
  assert(!requests[3]!.messages.filter((message) => message.role === "system").some((message) => message.content.includes("审查范围：src/tui")), "恢复后不再钉住 review");
  assert(rawBodies.every((raw) => !raw.includes("\"display\"")), "请求体不含 display 字段");
  await Bun.sleep(150);
  await send("/exit");
  console.log("TUI_COMMANDS_OK");
} finally {
  instance.unmount();
  releaseAgent?.();
  server.stop(true); stdin.destroy(); stdout.destroy(); f.cleanup();
}
