import { expect, test } from "bun:test";
import { createLoadSkillTool } from "../../src/skills/load-tool.js";
import { LOAD_SKILL_TOOL, SkillManager } from "../../src/skills/manager.js";
import { makeSkill } from "./helpers.js";

const context = { workDir: "/w" };

test("加载共享 Skill：结果含已激活与可用工具，指令进入钉住区（AC8）", async () => {
  const manager = new SkillManager([makeSkill("commit", { tools: ["Bash", "Read"] })]);
  const result = await createLoadSkillTool(manager).execute({ name: "commit", args: "修复超时" }, context);
  expect(result.ok).toBe(true);
  expect(result.content).toContain("已激活 Skill commit");
  expect(result.content).toContain("Bash");
  expect(manager.pinnedText()).toContain("SOP_COMMIT：修复超时");
  expect(manager.allowedTools()?.has(LOAD_SKILL_TOOL)).toBe(true);
});

test("没写白名单的共享 Skill：可用工具写「全部工具」", async () => {
  const manager = new SkillManager([makeSkill("open")]);
  const result = await createLoadSkillTool(manager).execute({ name: "open" }, context);
  expect(result.content).toContain("全部工具");
});

test("加载独立 Skill：调用注入的运行器并返回其摘要（AC8）", async () => {
  const manager = new SkillManager([makeSkill("test", { mode: "isolated" })]);
  manager.setIsolatedRunner(async (_skill, args) => ({ ok: true, text: `跑完了 ${args}` }));
  const result = await createLoadSkillTool(manager).execute({ name: "test", args: "src" }, context);
  expect(result).toMatchObject({ ok: true, content: "【Skill test 结果】\n跑完了 src" });
  expect(manager.isActive("test")).toBe(false);
});

test("独立 Skill 未完成时返回错误结果", async () => {
  const manager = new SkillManager([makeSkill("test", { mode: "isolated" })]);
  manager.setIsolatedRunner(async () => ({ ok: false, text: "已被用户中断" }));
  const result = await createLoadSkillTool(manager).execute({ name: "test" }, context);
  expect(result).toMatchObject({ ok: false, errorKind: "exec_failed" });
  expect(result.content).toContain("【Skill test 未完成】");
});

test("名字不存在：返回可用 Skill 列表，不抛异常（AC8、N4）", async () => {
  const manager = new SkillManager([makeSkill("commit"), makeSkill("review")]);
  const result = await createLoadSkillTool(manager).execute({ name: "nope" }, context);
  expect(result).toMatchObject({ ok: false, errorKind: "not_found" });
  expect(result.content).toContain("commit、review");
});

test("运行器抛错转成错误结果", async () => {
  const manager = new SkillManager([makeSkill("test", { mode: "isolated" })]);
  manager.setIsolatedRunner(async () => { throw new Error("炸了"); });
  const result = await createLoadSkillTool(manager).execute({ name: "test" }, context);
  expect(result).toMatchObject({ ok: false, errorKind: "exec_failed" });
  expect(result.content).toContain("炸了");
});

test("系统级、非只读，摘要带名字", () => {
  const tool = createLoadSkillTool(new SkillManager([]));
  expect(tool).toMatchObject({ name: LOAD_SKILL_TOOL, system: true, readOnly: false });
  expect(tool.callSummary({ name: "commit" })).toBe("loadSkill(commit)");
});
