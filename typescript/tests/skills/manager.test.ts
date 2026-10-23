import { describe, expect, test } from "bun:test";
import { LOAD_SKILL_TOOL, SkillManager } from "../../src/skills/manager.js";
import { makeSkill } from "./helpers.js";

const sorted = (set: ReadonlySet<string> | null) => (set ? [...set].sort() : null);

describe("激活与钉住（AC9）", () => {
  test("同时激活 A、B 按激活顺序钉住", () => {
    const manager = new SkillManager([makeSkill("a"), makeSkill("b")]);
    manager.activate("a", "1");
    manager.activate("b", "2");
    const text = manager.pinnedText();
    expect(text.indexOf("SOP_A：1")).toBeLessThan(text.indexOf("SOP_B：2"));
  });

  test("再次激活原位替换，不叠加、不改顺序", () => {
    const manager = new SkillManager([makeSkill("a"), makeSkill("b")]);
    manager.activate("a", "旧");
    manager.activate("b", "");
    manager.activate("a", "新");
    const text = manager.pinnedText();
    expect(text.match(/## Skill: a/g)).toHaveLength(1);
    expect(text).toContain("SOP_A：新");
    expect(text).not.toContain("SOP_A：旧");
    expect(text.indexOf("## Skill: a")).toBeLessThan(text.indexOf("## Skill: b"));
  });

  test("不存在或独立模式的 Skill 不能激活", () => {
    const manager = new SkillManager([makeSkill("iso", { mode: "isolated" })]);
    expect(() => manager.activate("nope", "")).toThrow();
    expect(() => manager.activate("iso", "")).toThrow();
  });
});

describe("停用（AC15 单元部分）", () => {
  test("停用单个与全部，返回实际停用的名字", () => {
    const manager = new SkillManager([makeSkill("a"), makeSkill("b")]);
    manager.activate("a", "");
    manager.activate("b", "");
    expect(manager.deactivate("x")).toEqual([]);
    expect(manager.deactivate("a")).toEqual(["a"]);
    expect(manager.isActive("a")).toBe(false);
    expect(manager.deactivate()).toEqual(["b"]);
    expect(manager.pinnedText()).toBe("");
    expect(manager.deactivate()).toEqual([]);
  });
});

describe("可用工具集合（AC11 单元部分）", () => {
  test("没有激活时不收窄", () => {
    expect(new SkillManager([makeSkill("a", { tools: ["Read"] })]).allowedTools()).toBeNull();
  });

  test("多个白名单取并集并加上加载工具", () => {
    const manager = new SkillManager([makeSkill("a", { tools: ["Bash", "Read"] }), makeSkill("b", { tools: ["Read", "Grep"] })]);
    manager.activate("a", "");
    manager.activate("b", "");
    expect(sorted(manager.allowedTools())).toEqual(["Bash", "Grep", "Read", LOAD_SKILL_TOOL].sort());
  });

  test("任一已激活 Skill 没写白名单时不收窄；停用它后恢复收窄", () => {
    const manager = new SkillManager([makeSkill("a", { tools: ["Read"] }), makeSkill("open")]);
    manager.activate("a", "");
    manager.activate("open", "");
    expect(manager.allowedTools()).toBeNull();
    manager.deactivate("open");
    expect(sorted(manager.allowedTools())).toEqual(["Read", LOAD_SKILL_TOOL].sort());
  });
});

describe("独立模式转发", () => {
  test("没注入运行器时返回未就绪", async () => {
    const manager = new SkillManager([makeSkill("iso", { mode: "isolated" })]);
    expect(await manager.runIsolated("iso", "", { workDir: "/w" })).toEqual({ ok: false, text: "独立模式运行器未就绪" });
  });

  test("注入后把 Skill、参数与上下文交给运行器", async () => {
    const manager = new SkillManager([makeSkill("iso", { mode: "isolated" })]);
    const seen: string[] = [];
    manager.setIsolatedRunner(async (skill, args, context) => {
      seen.push(`${skill.name}|${args}|${context.workDir}`);
      return { ok: true, text: "完成" };
    });
    expect(await manager.runIsolated("iso", "范围", { workDir: "/w" })).toEqual({ ok: true, text: "完成" });
    expect(seen).toEqual(["iso|范围|/w"]);
    await expect(manager.runIsolated("nope", "", { workDir: "/w" })).rejects.toThrow();
  });
});
