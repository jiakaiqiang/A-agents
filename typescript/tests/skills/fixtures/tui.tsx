// Skill 系统的真实 Ink 端到端驱动：假 openai-compat SSE provider + PassThrough 终端。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink";
import { createBuiltinRegistry } from "../../../src/commands/builtins/index.js";
import { bootstrapSkills } from "../../../src/commands/builtins/skills.js";
import { sessionsDir } from "../../../src/memory/session.js";
import { createDefaultRegistry } from "../../../src/tools/index.js";
import { App } from "../../../src/tui/app.js";
import { fixture } from "../../memory/helpers.js";

const f = fixture();
const skillsDir = join(f.workDir, ".mewcode", "skills");
const md = (name: string, head: string, body: string) => `---\nname: ${name}\n${head}---\n${body}\n`;
f.write(join(skillsDir, "commit.md"), md("commit", "description: 项目级提交\ntools: [Bash, Read]\n", "SOP_COMMIT_MARK 关注点：$ARGUMENTS"));
f.write(join(skillsDir, "clear.md"), md("clear", "description: 与内置命令重名\n", "不会被加载"));
f.write(join(skillsDir, "broken.md"), "---\nname: broken\ndescription: [未闭合\n---\n正文\n");
f.write(join(skillsDir, "deploy.md"), md("deploy", "description: 部署\ntools: [Deploy]\n", "不会被加载"));
f.write(join(skillsDir, "iso.md"), md("iso", "description: 独立跑\ntools: [Read]\nmode: isolated\nhistory: 2\nmodel: iso-model\n", "ISO_SOP 范围：$ARGUMENTS"));
f.write(join(f.workDir, "note.txt"), "hello");

type Body = { model: string; messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] };
interface Request { model: string; system: string; tools: string[]; messages: Body["messages"] }

let output = "";
let releaseHold: (() => void) | undefined;
const requests: Request[] = []; // 主对话与子对话请求；记忆整理请求不计入
const rawBodies: string[] = [];

const plain = () => stripVTControlCharacters(output).replaceAll("▌", "");
const since = (mark: number) => stripVTControlCharacters(output.slice(mark)).replaceAll("▌", "");

async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 8000) throw new Error(`超时：${label}\n${plain().slice(-3000)}`);
    await Bun.sleep(20);
  }
}

function sse(reply: { text?: string; tool?: { name: string; args: Record<string, unknown> } }, hold = false): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    const finish = () => {
      try {
        if (reply.tool) {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        } else {
          send({ choices: [{ index: 0, delta: { content: reply.text } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch { /* 中断后连接可能已关闭。 */ }
    };
    if (hold) {
      send({ choices: [{ index: 0, delta: { content: "WAITING_MARKER" } }] });
      releaseHold = finish;
    } else finish();
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const raw = await request.text();
  rawBodies.push(raw);
  const body = JSON.parse(raw) as Body;
  if (body.messages.some((m) => m.content?.includes("你是记忆整理器"))) return sse({ text: JSON.stringify({ operations: [] }) });
  const system = body.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");
  requests.push({ model: body.model, system, tools: (body.tools ?? []).map((t) => t.function.name), messages: body.messages });
  const last = body.messages.at(-1)!;
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  // 独立子对话：先调一次 Read，拿到结果后给结论；参数含 ISO_HOLD 时挂起，用来测 Esc 中断。
  if (body.messages.some((m) => m.content?.includes("ISO_SOP"))) {
    if (lastUser.includes("ISO_HOLD")) return sse({ text: "不会到达" }, true);
    return last.role === "tool" ? sse({ text: "ISO_DONE 结论" }) : sse({ tool: { name: "Read", args: { file_path: join(f.workDir, "note.txt") } } });
  }
  // commit 已激活：先硬调白名单外的 Write，拿到结果后收尾。
  if (system.includes("SOP_COMMIT_MARK") && lastUser.startsWith("执行 Skill commit")) {
    return last.role === "tool" ? sse({ text: "COMMIT_DONE" }) : sse({ tool: { name: "Write", args: { file_path: join(f.workDir, "blocked.txt"), content: "x" } } });
  }
  return sse({ text: "ANSWER_DONE" });
} });

const stdout = new PassThrough();
stdout.on("data", (chunk) => { output += chunk.toString(); });
Object.assign(stdout, { columns: 140, rows: 50 });
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
// 与 main.tsx 走同一段装配。
const registry = createDefaultRegistry();
const commands = createBuiltinRegistry();
const booted = bootstrapSkills({ registry, commands, workDir: f.workDir, homeDir: f.homeDir });
const instance = render(<App
  providers={[{ name: "test", protocol: "openai-compat", base_url: `http://127.0.0.1:${server.port}/v1`, model: "main-model", api_key: "test", context_window: 128_000 }]}
  hooks={[]} registry={registry} commands={commands} skills={booted.manager}
  skillReport={{ warnings: booted.warnings, summary: booted.summary }} workDir={f.workDir} homeDir={f.homeDir}
/>, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false });

const press = async (key: string) => { stdin.write(key); await Bun.sleep(80); };
const send = async (text: string) => { stdin.write(text); await Bun.sleep(60); await press("\r"); };
const settle = () => Bun.sleep(200);
const ALL_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "toolSearch", "loadSkill"].sort();

try {
  await Bun.sleep(300);
  // —— 启动报告（AC1、AC5、AC6、AC17） ——
  await until(() => plain().includes("已加载 Skill"), "加载摘要");
  const boot = plain();
  // 内部 review、test + 项目 commit（覆盖内部 commit）、iso；clear、broken、deploy 被剔除。
  assert(boot.includes("已加载 Skill 4 个（内部 2、用户 0、项目 2）"), `摘要计数：${/已加载 Skill[^\n]*/.exec(boot)?.[0]}`);
  for (const [file, reason] of [["broken.md", "不是合法 YAML"], ["deploy.md", "不存在的工具 Deploy"], ["clear.md", "与内置命令 /clear 重名"]]) {
    assert(boot.includes(file) && boot.includes(reason), `启动告警：${file} ${reason}`);
  }

  // —— 第一阶段：目录可见、SOP 不可见（AC7） ——
  await send("hello");
  await until(() => requests.length === 1 && plain().includes("ANSWER_DONE"), "首个请求");
  const first = requests[0]!;
  for (const name of ["commit", "iso", "review", "test"]) assert(first.system.includes(`- ${name}: `), `目录含 ${name}`);
  assert(!first.system.includes("SOP_COMMIT_MARK") && !first.system.includes("ISO_SOP"), "目录不含 SOP 正文");
  assert.deepEqual([...first.tools].sort(), ALL_TOOLS, "未激活时工具为原有工具 + loadSkill");
  await settle();

  // —— 共享 Skill 斜杠调用：项目级覆盖、钉住、触发语、白名单收窄与拦截（AC3、AC10、AC11） ——
  let mark = output.length;
  await send("/commit 修复登录超时");
  await until(() => since(mark).includes("COMMIT_DONE"), "commit 一轮完成");
  const commitReq = requests[1]!;
  assert(commitReq.system.includes("SOP_COMMIT_MARK 关注点：修复登录超时"), "钉住项目级 commit 且参数已替换");
  assert.equal(commitReq.messages.filter((m) => m.role === "user").at(-1)!.content, "执行 Skill commit，参数：修复登录超时");
  assert.deepEqual([...commitReq.tools].sort(), ["Bash", "Read", "loadSkill"].sort(), "工具收窄为白名单 + loadSkill");
  assert(since(mark).includes("/commit 修复登录超时"), "对话区显示原命令");
  const blocked = requests[2]!.messages.find((m) => m.role === "tool")!.content ?? "";
  assert(blocked.includes("不在当前可用工具中"), `白名单外的 Write 被拦下，实际：${blocked}`);
  assert(!existsSync(join(f.workDir, "blocked.txt")), "Write 未执行");
  await settle();

  // —— /skills 与停用（AC15） ——
  mark = output.length;
  await send("/skills");
  await until(() => since(mark).includes("● 已激活"), "/skills 标出已激活");
  await send("/skills off commit");
  await until(() => plain().includes("已停用 Skill commit"), "停用提示");
  const beforeOff = requests.length;
  await send("after-off");
  await until(() => requests.length === beforeOff + 1, "停用后请求");
  await settle();
  const afterOff = requests.at(-1)!;
  assert(!afterOff.system.includes("SOP_COMMIT_MARK"), "停用后不再钉住");
  assert.deepEqual([...afterOff.tools].sort(), ALL_TOOLS, "停用后工具恢复全部");

  // —— 独立 Skill：模型名、历史条数、工具范围、前缀工具行、两条回流（AC13、AC14） ——
  mark = output.length;
  const beforeIso = requests.length;
  await send("/iso 范围X");
  await until(() => since(mark).includes("【Skill iso 结果】"), "独立 Skill 完成");
  const isoReq = requests[beforeIso]!;
  assert.equal(isoReq.model, "iso-model", "子对话使用指定模型名");
  assert.deepEqual(isoReq.tools, ["Read"], "子对话只有白名单工具，没有 loadSkill");
  assert.deepEqual(isoReq.messages.filter((m) => m.role !== "system").map((m) => m.content), ["after-off", "ANSWER_DONE", "ISO_SOP 范围：范围X"], "最近 2 条主历史 + SOP");
  assert(since(mark).includes("[iso] "), "子对话工具行带前缀");
  assert(since(mark).includes("ISO_DONE 结论"), "结果显示子对话最后一条回复");
  await settle();
  const beforeAfterIso = requests.length;
  await send("after-iso");
  await until(() => requests.length === beforeAfterIso + 1, "独立轮之后的主对话");
  await settle();
  const mainAfterIso = requests.at(-1)!.messages.filter((m) => m.role !== "system").map((m) => m.content ?? "");
  assert.deepEqual(mainAfterIso.slice(-3), ["/iso 范围X", "【Skill iso 结果】\nISO_DONE 结论", "after-iso"], "主历史只多原命令与结果两条");
  assert(!mainAfterIso.some((content) => content.includes("ISO_SOP")), "子对话内容不进主历史");

  // —— 独立 Skill 中断（AC14） ——
  mark = output.length;
  await send("/iso ISO_HOLD");
  await until(() => !!releaseHold, "子对话挂起");
  await press("\u001b");
  await until(() => since(mark).includes("【Skill iso 未完成】"), "中断后回流未完成说明");
  assert(since(mark).includes("本轮已中断"), "中断提示");
  releaseHold = undefined;
  await settle();
  const beforeRecover = requests.length;
  await send("after-cancel");
  await until(() => requests.length === beforeRecover + 1 && plain().split("ANSWER_DONE").length > 3, "中断后正常对话");
  await settle();
  const sessionText = readdirSync(sessionsDir(f.workDir)).filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(sessionsDir(f.workDir), name), "utf8")).join("\n");
  assert(sessionText.includes("/iso 范围X") && !sessionText.includes("ISO_SOP"), "会话存档含原命令、不含子对话");
  assert(rawBodies.every((raw) => !raw.includes("\"display\"")), "请求体不含 display 字段");

  // —— /clear 与 /resume 后停用（AC15） ——
  await send("/commit 再来");
  await until(() => plain().split("COMMIT_DONE").length > 2, "再次激活 commit");
  await settle();
  mark = output.length;
  await send("/clear");
  await until(() => since(mark).includes("已清空对话"), "/clear");
  const beforeClear = requests.length;
  await send("after-clear");
  await until(() => requests.length === beforeClear + 1, "/clear 后请求");
  await settle();
  assert(!requests.at(-1)!.system.includes("SOP_COMMIT_MARK"), "/clear 后不再钉住");
  await send("/commit 三次");
  await until(() => plain().split("COMMIT_DONE").length > 3, "新会话里激活 commit");
  await settle();
  mark = output.length;
  await send("/resume");
  await until(() => since(mark).includes("恢复历史会话"), "恢复列表");
  await press("\r");
  await until(() => since(mark).includes("已恢复会话"), "恢复完成");
  await settle();
  const beforeResume = requests.length;
  await send("after-resume");
  await until(() => requests.length === beforeResume + 1, "/resume 后请求");
  await settle();
  assert(!requests.at(-1)!.system.includes("SOP_COMMIT_MARK"), "/resume 后不再钉住");
  await send("/exit");
  console.log("TUI_SKILLS_OK");
} finally {
  instance.unmount();
  releaseHold?.();
  server.stop(true); stdin.destroy(); stdout.destroy(); f.cleanup();
}
