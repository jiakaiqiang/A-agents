import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/conversation/conversation.js";
import { isolatedToolScope, recentHistory, resultMessage, runIsolatedSkill } from "../../src/skills/isolated.js";
import { LOAD_SKILL_TOOL, SkillManager } from "../../src/skills/manager.js";
import { createLoadSkillTool } from "../../src/skills/load-tool.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { call, makeSkill, recordingClient, text } from "./helpers.js";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });
const toolUse = (id: string): Message => ({ role: "assistant", content: "", toolUses: [{ id, name: "Read", arguments: {} }] });
const toolResult = (id: string): Message => ({ role: "user", content: "", toolResults: [{ toolUseId: id, content: "r" }] });

describe("recentHistory（spec F11）", () => {
  test("n 为 0 返回空", () => {
    expect(recentHistory([user("a"), assistant("b")], 0)).toEqual([]);
  });

  test("刚好切在工具结果上时少取，保证配对完整", () => {
    const history = [user("早"), toolUse("t1"), toolResult("t1"), assistant("答")];
    // 末尾 2 条是「工具结果 + 回答」，工具调用被切掉了，起点推进到下一条普通用户消息：没有，返回空。
    expect(recentHistory(history, 2)).toEqual([]);
    expect(recentHistory(history, 4)).toEqual(history);
  });

  test("末尾悬空的工具调用被丢掉", () => {
    const history = [user("问"), assistant("答"), user("再问"), toolUse("loading")];
    expect(recentHistory(history, 2)).toEqual([user("再问")]);
  });

  test("n 大于总数返回全部可用消息，并去掉 system 消息", () => {
    const history: Message[] = [{ role: "system", content: "提醒" }, user("a"), assistant("b")];
    expect(recentHistory(history, 10)).toEqual([user("a"), assistant("b")]);
  });

  test("返回深拷贝，不影响主历史", () => {
    const history = [user("a")];
    recentHistory(history, 1)[0]!.content = "改了";
    expect(history[0]!.content).toBe("a");
  });
});

describe("isolatedToolScope 与 resultMessage", () => {
  test("白名单为空时为全部工具，两种情况都不含加载工具", () => {
    const registry = createDefaultRegistry();
    registry.register(createLoadSkillTool(new SkillManager([])));
    expect(isolatedToolScope(makeSkill("x"), registry).has(LOAD_SKILL_TOOL)).toBe(false);
    expect(isolatedToolScope(makeSkill("x"), registry).has("Bash")).toBe(true);
    expect([...isolatedToolScope(makeSkill("x", { tools: ["Read", LOAD_SKILL_TOOL] }), registry)]).toEqual(["Read"]);
  });

  test("结果文本区分完成与未完成", () => {
    expect(resultMessage("test", { ok: true, text: "全部通过" })).toBe("【Skill test 结果】\n全部通过");
    expect(resultMessage("test", { ok: false, text: "已被用户中断" })).toBe("【Skill test 未完成】已被用户中断");
  });
});

describe("runIsolatedSkill（AC13 单元部分）", () => {
  const base = { registry: createDefaultRegistry(), protocol: "anthropic" as const, workDir: process.cwd(), mode: "execute" as const };

  async function drain(generator: AsyncGenerator<unknown, unknown>) {
    const events: unknown[] = [];
    for (;;) {
      const step = await generator.next();
      if (step.done) return { events, outcome: step.value };
      events.push(step.value);
    }
  }

  test("请求含最近 history 条与替换后的 SOP；工具只有白名单；最后一条回复即摘要", async () => {
    const registry = createDefaultRegistry();
    registry.register(createLoadSkillTool(new SkillManager([])));
    const { client, requests } = recordingClient([call("t1", "Glob", { pattern: "zz-none-*" }), text("测试全部通过")]);
    const skill = makeSkill("test", { mode: "isolated", history: 2, tools: ["Glob", "Read"] });
    const history = [user("很早"), assistant("早答"), user("最近问"), assistant("最近答")];

    const { events, outcome } = await drain(runIsolatedSkill({ ...base, registry, skill, args: "src/auth", history, client }));

    expect(outcome).toEqual({ ok: true, text: "测试全部通过" });
    expect(requests[0]!.messages.map((m) => m.content)).toEqual(["最近问", "最近答", "SOP_TEST：src/auth"]);
    expect(requests[0]!.tools.sort()).toEqual(["Glob", "Read"]);
    expect(requests[0]!.pinned).toBeUndefined();
    expect(events.some((event) => (event as { type: string }).type === "tool_start")).toBe(true);
    expect(events.some((event) => (event as { type: string }).type === "done")).toBe(false);
  });

  test("白名单为空时子对话也拿不到加载工具", async () => {
    const registry = createDefaultRegistry();
    registry.register(createLoadSkillTool(new SkillManager([])));
    const { client, requests } = recordingClient([text("好")]);
    await drain(runIsolatedSkill({ ...base, registry, skill: makeSkill("x", { mode: "isolated" }), args: "", history: [], client }));
    expect(requests[0]!.tools).not.toContain(LOAD_SKILL_TOOL);
    expect(requests[0]!.tools).toContain("Bash");
  });

  test("中断与客户端抛错都返回未完成，不向外抛", async () => {
    const controller = new AbortController();
    const { client } = recordingClient([text("不会到")], { beforeEach: async () => { controller.abort(); } });
    const aborted = await drain(runIsolatedSkill({ ...base, skill: makeSkill("x", { mode: "isolated" }), args: "", history: [], client, signal: controller.signal }));
    expect(aborted.outcome).toMatchObject({ ok: false });

    const broken = { async *stream() { throw new Error("网关 502"); } };
    const failed = await drain(runIsolatedSkill({ ...base, skill: makeSkill("x", { mode: "isolated" }), args: "", history: [], client: broken }));
    expect(failed.outcome).toEqual({ ok: false, text: "模型请求失败：网关 502" });
  });
});
