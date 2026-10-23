import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { builtinSkillsDir, loadSkills } from "../../src/skills/loader.js";
import { fixture } from "../memory/helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

const TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "toolSearch", "loadSkill"]);
const skill = (name: string, extra = "", body = `${name} 正文`) => `---\nname: ${name}\ndescription: ${name} 说明\n${extra}---\n${body}\n`;
const dirs = () => ({
  builtin: join(f.root, "builtin"),
  user: join(f.homeDir, ".mewcode", "skills"),
  project: join(f.workDir, ".mewcode", "skills"),
});
const load = (availableTools: ReadonlySet<string> = TOOLS) =>
  loadSkills({ workDir: f.workDir, homeDir: f.homeDir, availableTools, builtinDir: dirs().builtin });

describe("三级发现与覆盖（AC3、AC4）", () => {
  test("同名时项目级 > 用户级 > 内部", () => {
    const d = dirs();
    f.write(join(d.builtin, "commit.md"), skill("commit", "", "内部"));
    f.write(join(d.user, "commit.md"), skill("commit", "", "用户"));
    f.write(join(d.project, "commit.md"), skill("commit", "", "项目"));
    expect(load().skills.map((s) => [s.body, s.source])).toEqual([["项目", "project"]]);
    rmSync(join(d.project, "commit.md"));
    expect(load().skills.map((s) => [s.body, s.source])).toEqual([["用户", "user"]]);
  });

  test("同层 x.md 与 x/SKILL.md 并存用目录型并告警；目录里的其他文件不算 Skill", () => {
    const d = dirs();
    f.write(join(d.project, "deploy.md"), skill("deploy", "", "单文件"));
    f.write(join(d.project, "deploy", "SKILL.md"), skill("deploy", "", "目录型"));
    f.write(join(d.project, "deploy", "notes.md"), skill("notes"));
    const result = load();
    expect(result.skills.map((s) => s.body)).toEqual(["目录型"]);
    expect(result.warnings.some((w) => w.includes("deploy.md") && w.includes("使用目录型"))).toBe(true);
  });

  test("一个损坏一个正常：正常的可用，损坏的告警含路径与原因", () => {
    const d = dirs();
    f.write(join(d.project, "good.md"), skill("good"));
    f.write(join(d.project, "bad.md"), "---\nname: bad\ndescription: [未闭合\n---\n正文\n");
    const result = load();
    expect(result.skills.map((s) => s.name)).toEqual(["good"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(join(d.project, "bad.md"));
    expect(result.warnings[0]).toContain("不是合法 YAML");
  });

  test("skills 目录不存在时无告警", () => {
    expect(load()).toEqual({ skills: [], warnings: [], counts: { builtin: 0, user: 0, project: 0 } });
  });

  test("目录名与 name 不一致时跳过", () => {
    f.write(join(dirs().project, "alpha", "SKILL.md"), skill("beta"));
    const result = load();
    expect(result.skills).toEqual([]);
    expect(result.warnings[0]).toContain("不一致");
  });

  test("计数按覆盖后的最终来源统计，结果按名字排序", () => {
    const d = dirs();
    f.write(join(d.builtin, "zeta.md"), skill("zeta"));
    f.write(join(d.builtin, "alpha.md"), skill("alpha"));
    f.write(join(d.project, "alpha.md"), skill("alpha"));
    const result = load();
    expect(result.skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(result.counts).toEqual({ builtin: 1, user: 0, project: 1 });
  });
});

describe("白名单校验与安全读取（AC5、AC18）", () => {
  test("白名单含不存在的工具：跳过并写明路径与工具名", () => {
    const path = join(dirs().project, "deploy.md");
    f.write(path, skill("deploy", "tools: [Bash, Deploy, Ship]\n"));
    const result = load();
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([`${path}：白名单包含不存在的工具 Deploy、Ship，本次未加载`]);
  });

  test("白名单含本次可用的 MCP 工具名时正常加载", () => {
    f.write(join(dirs().project, "web.md"), skill("web", "tools: [mcp_search_web]\n"));
    expect(load(new Set([...TOOLS, "mcp_search_web"])).skills.map((s) => s.name)).toEqual(["web"]);
  });

  test("被覆盖的低层 Skill 不参与白名单校验", () => {
    const d = dirs();
    f.write(join(d.builtin, "x.md"), skill("x", "tools: [Nope]\n"));
    f.write(join(d.project, "x.md"), skill("x", "tools: [Read]\n"));
    expect(load()).toMatchObject({ skills: [{ name: "x", source: "project" }], warnings: [] });
  });

  test("超过 64KB 的文件被跳过并告警", () => {
    const path = join(dirs().project, "huge.md");
    f.write(path, skill("huge", "", "x".repeat(65 * 1024)));
    const result = load();
    expect(result.skills).toEqual([]);
    expect(result.warnings[0]).toContain("超过 64KB");
  });

  // Windows 未开开发者模式时创建符号链接需要管理员权限，此时跳过该用例。
  let canSymlink = true;
  try {
    const probe = fixture();
    probe.write(join(probe.root, "t.md"), "x");
    symlinkSync(join(probe.root, "t.md"), join(probe.root, "l.md"));
    probe.cleanup();
  } catch { canSymlink = false; }

  test("目录型 Skill 经目录链接指向 skills 目录之外时被跳过", () => {
    const outside = join(f.root, "outside-dir");
    f.write(join(outside, "SKILL.md"), skill("evil"));
    mkdirSync(dirs().project, { recursive: true });
    // junction 在 Windows 上无需管理员权限；其他平台该参数被忽略，创建普通符号链接。
    symlinkSync(outside, join(dirs().project, "evil"), "junction");
    const result = load();
    expect(result.skills).toEqual([]);
    expect(result.warnings[0]).toContain("指向 skills 目录之外");
  });

  test.skipIf(!canSymlink)("指向 skills 目录之外的符号链接被跳过", () => {
    const outside = join(f.root, "outside.md");
    f.write(outside, skill("evil"));
    mkdirSync(dirs().project, { recursive: true });
    symlinkSync(outside, join(dirs().project, "evil.md"));
    const result = load();
    expect(result.skills).toEqual([]);
    expect(result.warnings[0]).toContain("指向 skills 目录之外");
  });
});

describe("内部样板（AC16）", () => {
  test("commit、review、test 全部加载成功，模式与白名单符合定义", () => {
    const result = loadSkills({ workDir: f.workDir, homeDir: f.homeDir, availableTools: TOOLS, builtinDir: builtinSkillsDir() });
    expect(result.warnings).toEqual([]);
    expect(result.skills.map((s) => [s.name, s.mode, s.source])).toEqual([
      ["commit", "shared", "builtin"], ["review", "shared", "builtin"], ["test", "isolated", "builtin"],
    ]);
    for (const s of result.skills) expect(s.tools).toEqual(["Bash", "Read", "Glob", "Grep"]);
    expect(result.skills.every((s) => s.body.includes("$ARGUMENTS"))).toBe(true);
  });
});
