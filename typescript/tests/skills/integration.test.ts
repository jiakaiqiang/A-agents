import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../../src/agent/events.js";
import { runLoop } from "../../src/agent/loop.js";
import { Compactor } from "../../src/context/compactor.js";
import { TokenEstimator } from "../../src/context/tokens.js";
import { ConversationManager } from "../../src/conversation/conversation.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { PermissionGate } from "../../src/permission/types.js";
import { createLoadSkillTool } from "../../src/skills/load-tool.js";
import { LOAD_SKILL_TOOL, SkillManager } from "../../src/skills/manager.js";
import { createDefaultRegistry, type ToolRegistry } from "../../src/tools/index.js";
import { MAX_INVALID_ITERATIONS } from "../../src/tools/limits.js";
import { ok } from "../../src/tools/types.js";
import { fixture } from "../memory/helpers.js";
import { gateWith } from "../permission/helpers.js";
import { call, makeSkill, recordingClient, text } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

const SKILLS = [
  makeSkill("a", { tools: ["Bash", "Read"] }),
  makeSkill("b", { tools: ["Read", "Grep"] }),
  makeSkill("open"),
  makeSkill("lazy", { tools: ["Read", "toolSearch", "mcp_web"] }),
];

function setup() {
  const manager = new SkillManager(SKILLS);
  const registry = createDefaultRegistry();
  registry.register(createLoadSkillTool(manager));
  registry.registerLazy({ name: "mcp_web", description: "网页搜索", loader: async () => ({ ...registry.get("Read")!, name: "mcp_web", execute: async () => ok("x", "x") }) });
  registry.registerLazy({ name: "mcp_other", description: "别的", loader: async () => registry.get("Read")! });
  return { manager, registry };
}

async function run(client: LLMClient, registry: ToolRegistry, manager: SkillManager | undefined, extra: { permission?: PermissionGate; conversation?: ConversationManager; compactor?: Compactor } = {}) {
  const conversation = extra.conversation ?? new ConversationManager();
  if (!conversation.len()) conversation.addUserMessage("开始");
  const events: AgentEvent[] = [];
  for await (const event of runLoop({
    client, conversation, registry, protocol: "anthropic", workDir: f.workDir, mode: "execute",
    permission: extra.permission ?? gateWith("bypass"), compactor: extra.compactor, ...(manager ? { skills: manager } : {}),
  })) events.push(event);
  return { events, conversation, done: events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }> };
}

const sorted = (names: string[]) => [...names].sort();

describe("没有激活 Skill 时行为不变（AC19、N7）", () => {
  test("工具列表为原有工具加 loadSkill，不钉住，延迟目录照常注入", async () => {
    const { manager, registry } = setup();
    const { client, requests } = recordingClient([text("好")]);
    await run(client, registry, manager);
    expect(sorted(requests[0]!.tools)).toEqual(sorted(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "toolSearch", LOAD_SKILL_TOOL]));
    expect(requests[0]!.pinned).toBeUndefined();
    expect(requests[0]!.reminders.join("\n")).toContain("mcp_web");
  });

  test("不传 skills 时同样不钉住、不收窄", async () => {
    const { registry } = setup();
    const { client, requests } = recordingClient([text("好")]);
    await run(client, registry, undefined);
    expect(requests[0]!.tools).toHaveLength(8);
    expect(requests[0]!.pinned).toBeUndefined();
  });
});

describe("白名单收窄（AC11、AC12）", () => {
  test("两个白名单取并集加 loadSkill；再激活无白名单 Skill 恢复全部", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "");
    manager.activate("b", "");
    const first = recordingClient([text("好")]);
    await run(first.client, registry, manager);
    expect(sorted(first.requests[0]!.tools)).toEqual(sorted(["Bash", "Read", "Grep", LOAD_SKILL_TOOL]));

    manager.activate("open", "");
    const second = recordingClient([text("好")]);
    await run(second.client, registry, manager);
    expect(second.requests[0]!.tools).toHaveLength(8);
  });

  test("模型调用白名单外的 Write：不执行，回灌不可用提示", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "");
    const target = join(f.workDir, "x.txt");
    const { client } = recordingClient([call("w1", "Write", { file_path: target, content: "hi" }), text("好")]);
    const { conversation } = await run(client, registry, manager);
    expect(existsSync(target)).toBe(false);
    const result = conversation.getMessages().flatMap((m) => m.toolResults ?? [])[0]!;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("不在当前可用工具中");
  });

  test("连续只调白名单外工具：按无效迭代上限中止", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "");
    const scripts = Array.from({ length: MAX_INVALID_ITERATIONS + 2 }, (_, i) => call(`w${i}`, "Write", { file_path: "x", content: "y" }));
    const { client } = recordingClient(scripts);
    const { done } = await run(client, registry, manager);
    expect(done.reason).toBe("invalid_tools");
    expect(done.iterations).toBe(MAX_INVALID_ITERATIONS);
  });

  test("白名单不含 toolSearch 时不注入延迟目录；含 toolSearch 时只列白名单内的延迟工具", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "");
    const without = recordingClient([text("好")]);
    await run(without.client, registry, manager);
    expect(without.requests[0]!.reminders.join("\n")).not.toContain("延迟加载工具");

    manager.deactivate();
    manager.activate("lazy", "");
    const withSearch = recordingClient([text("好")]);
    await run(withSearch.client, registry, manager);
    const catalog = withSearch.requests[0]!.reminders.join("\n");
    expect(catalog).toContain("mcp_web");
    expect(catalog).not.toContain("mcp_other");
  });

  test("白名单内的 Bash 在默认档仍要确认（N6）", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "");
    let asked = 0;
    const permission = gateWith("default", undefined, { confirm: async () => { asked += 1; return "deny"; } });
    const { client } = recordingClient([call("b1", "Bash", { command: "echo hi" }), text("好")]);
    await run(client, registry, manager, { permission });
    expect(asked).toBe(1);
  });
});

describe("钉住与模型侧加载（AC8、AC9）", () => {
  test("激活 A、B 后每次迭代都带两段 SOP，且 A 在前", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "1");
    manager.activate("b", "2");
    const { client, requests } = recordingClient([call("g1", "Read", { file_path: join(f.workDir, "none") }), text("好")]);
    await run(client, registry, manager);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.pinned!.indexOf("SOP_A：1")).toBeLessThan(request.pinned!.indexOf("SOP_B：2"));
    }
    // 钉住内容不进对话历史。
    expect(requests.at(-1)!.messages.some((m) => m.content.includes("SOP_A"))).toBe(false);
  });

  test("模型中途调用 loadSkill：下一次请求钉住该 SOP 并收窄工具，加载工具仍在列表里", async () => {
    const { manager, registry } = setup();
    const { client, requests } = recordingClient([call("l1", LOAD_SKILL_TOOL, { name: "a", args: "参数" }), text("好")]);
    const { conversation } = await run(client, registry, manager);
    expect(requests[0]!.pinned).toBeUndefined();
    expect(requests[1]!.pinned).toContain("SOP_A：参数");
    expect(sorted(requests[1]!.tools)).toEqual(sorted(["Bash", "Read", LOAD_SKILL_TOOL]));
    expect(conversation.getMessages().flatMap((m) => m.toolResults ?? [])[0]!.content).toContain("已激活");
  });

  test("加载工具在默认档不弹确认", async () => {
    const { manager, registry } = setup();
    let asked = 0;
    const permission = gateWith("default", undefined, { confirm: async () => { asked += 1; return "deny"; } });
    const { client } = recordingClient([call("l1", LOAD_SKILL_TOOL, { name: "a" }), text("好")]);
    await run(client, registry, manager, { permission });
    expect(asked).toBe(0);
    expect(manager.isActive("a")).toBe(true);
  });

  test("上下文压缩后钉住内容仍在", async () => {
    const { manager, registry } = setup();
    manager.activate("a", "压缩前");
    const conversation = new ConversationManager();
    for (let i = 0; i < 12; i += 1) conversation.addUserMessage("字".repeat(3_500));
    // 第 1 次是摘要请求（无工具），第 2 次才是本轮对话。
    const { client, requests } = recordingClient([text("摘要正文"), text("好")]);
    const compactor = new Compactor(client, conversation, new TokenEstimator(), f.workDir, 20_000);
    const { events } = await run(client, registry, manager, { conversation, compactor });
    expect(events.some((e) => e.type === "compaction")).toBe(true);
    const chat = requests.filter((r) => r.tools.length > 0);
    expect(chat.at(-1)!.pinned).toContain("SOP_A：压缩前");
  });
});
