import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../src/commands/builtins/index.js";
import { bootstrapSkills, registerSkillCommands, skillCommand } from "../../src/commands/builtins/skills.js";
import { suggest } from "../../src/commands/completion.js";
import { dispatch } from "../../src/commands/dispatcher.js";
import { formatHelp } from "../../src/commands/format.js";
import { LOAD_SKILL_TOOL } from "../../src/skills/manager.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { fakeUI, messages } from "../commands/fake-ui.js";
import { fixture } from "../memory/helpers.js";
import { makeSkill } from "./helpers.js";

describe("Skill 斜杠命令（AC6）", () => {
  test("Skill 出现在 /help 与补全中，描述带「（Skill）」", () => {
    const commands = createBuiltinRegistry();
    registerSkillCommands(commands, [makeSkill("commit")]);
    expect(formatHelp(commands)).toContain("commit 说明（Skill）");
    expect(suggest("/co", commands).map((item) => item.name)).toContain("commit");
  });

  test("与内置命令名称或别名重名的 Skill 被跳过并告警，内置命令不变", () => {
    const commands = createBuiltinRegistry();
    const { accepted, warnings } = registerSkillCommands(commands, [makeSkill("clear"), makeSkill("h"), makeSkill("ok")]);
    expect(accepted.map((skill) => skill.name)).toEqual(["ok"]);
    expect(warnings).toEqual([
      "/builtin/clear.md：与内置命令 /clear 重名，已跳过",
      "/builtin/h.md：与内置命令 /help 重名，已跳过",
    ]);
    expect(commands.resolve("clear")?.description).not.toContain("Skill");
  });

  test("调用时把名字、参数、原命令交给界面；无参时原命令不带空格", () => {
    const commands = createBuiltinRegistry();
    registerSkillCommands(commands, [makeSkill("commit")]);
    const { ui, calls } = fakeUI();
    expect(dispatch("/commit  修复登录超时 ", { registry: commands, ui, busy: false })).toBe("done");
    expect(dispatch("/commit", { registry: commands, ui, busy: false })).toBe("done");
    expect(calls.filter((c) => c.method === "invokeSkill").map((c) => c.args)).toEqual([
      ["commit", "修复登录超时", "/commit 修复登录超时"],
      ["commit", "", "/commit"],
    ]);
  });

  test("Agent 运行中 Skill 命令被拒，提示与其他命令一致", () => {
    const commands = createBuiltinRegistry();
    registerSkillCommands(commands, [makeSkill("commit")]);
    const { ui, calls } = fakeUI();
    expect(dispatch("/commit", { registry: commands, ui, busy: true })).toBe("rejected");
    expect(messages(calls)).toEqual(["Agent 运行中，请稍后或按 Esc 中断"]);
  });

  test("客户端未就绪时提示", () => {
    const { ui, calls } = fakeUI({ invokeSkill: () => false });
    const def = skillCommand(makeSkill("commit"));
    if (def.kind !== "prompt") def.run({ args: "", ui, registry: createBuiltinRegistry() });
    expect(messages(calls)[0]).toContain("尚未就绪");
  });
});

describe("/skills（AC15 单元部分）", () => {
  const items = [
    { name: "commit", description: "提交", mode: "shared" as const, source: "builtin" as const, active: true },
    { name: "test", description: "测试", mode: "isolated" as const, source: "project" as const, active: false },
  ];

  function run(text: string, deactivated: string[] = []) {
    const { ui, calls } = fakeUI({ listSkills: () => items, deactivateSkills: () => deactivated });
    dispatch(text, { registry: createBuiltinRegistry(), ui, busy: false });
    return { calls, shown: messages(calls) };
  }

  test("无参列出全部并标出已激活", () => {
    expect(run("/skills").shown[0]).toContain("● 已激活");
  });

  test("off 停用全部；没有激活时提示", () => {
    expect(run("/skills off", ["commit"]).shown).toEqual(["已停用 Skill：commit"]);
    expect(run("/skills off", []).shown).toEqual(["当前没有已激活的 Skill"]);
  });

  test("off <名字>：停用一个；未激活与不存在分别提示", () => {
    const { calls, shown } = run("/skills off commit", ["commit"]);
    expect(calls.find((c) => c.method === "deactivateSkills")?.args).toEqual(["commit"]);
    expect(shown).toEqual(["已停用 Skill commit"]);
    expect(run("/skills off test", []).shown).toEqual(["Skill test 当前未激活"]);
    expect(run("/skills off nope").shown[0]).toContain("未找到 Skill nope");
  });

  test("其他参数显示用法", () => {
    expect(run("/skills list").shown).toEqual(["用法：/skills [off [名字]]"]);
  });

  test("运行中也可用", () => {
    const { ui } = fakeUI({ listSkills: () => items });
    expect(dispatch("/skills", { registry: createBuiltinRegistry(), ui, busy: true })).toBe("done");
  });
});

describe("bootstrapSkills（AC17 单元部分）", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(() => f.cleanup());

  test("加载、登记、注册 loadSkill，摘要计数与告警一致", () => {
    const project = join(f.workDir, ".mewcode", "skills");
    f.write(join(project, "deploy.md"), "---\nname: deploy\ndescription: 部署\n---\n部署\n");
    f.write(join(project, "clear.md"), "---\nname: clear\ndescription: 清理\n---\n清理\n");
    f.write(join(project, "bad.md"), "---\nname: bad\n---\n正文\n");
    const registry = createDefaultRegistry();
    const commands = createBuiltinRegistry();
    const { manager, warnings, summary } = bootstrapSkills({ registry, commands, workDir: f.workDir, homeDir: f.homeDir });

    expect(manager.list().map((skill) => skill.name).sort()).toEqual(["commit", "deploy", "review", "test"]);
    expect(summary).toBe("已加载 Skill 4 个（内部 3、用户 0、项目 1）");
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("bad.md") && w.includes("description"))).toBe(true);
    expect(warnings.some((w) => w.includes("clear.md") && w.includes("重名"))).toBe(true);
    expect(registry.get(LOAD_SKILL_TOOL)).toBeDefined();
    expect(commands.resolve("review")?.description).toContain("（Skill）");
  });
});
