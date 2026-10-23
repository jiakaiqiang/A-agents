import { describe, expect, test } from "bun:test";
import { MODE_FALLBACK, PERMISSION_MODES, classifyTool } from "../../src/permission/limits.js";
import { runTool, ToolRegistry } from "../../src/tools/index.js";
import { ok, type Tool } from "../../src/tools/types.js";

function counting(name: string, extra: Partial<Tool> = {}): Tool & { calls: number } {
  const tool = {
    name, description: `${name} 工具`, readOnly: true, calls: 0,
    parameters: { type: "object" as const, properties: {}, required: [] },
    callSummary: () => name,
    async execute() { tool.calls += 1; return ok("done", name); },
    ...extra,
  };
  return tool;
}

const names = (defs: Record<string, unknown>[]) => defs.map((def) => def.name as string);

describe("工具层按集合收窄（Skill F10）", () => {
  test("definitionsFor 的 only 只导出集合内工具", () => {
    const registry = new ToolRegistry().register(counting("Read")).register(counting("Bash")).register(counting("Grep"));
    expect(names(registry.definitionsFor("anthropic", { only: new Set(["Read", "Grep", "Missing"]) }))).toEqual(["Read", "Grep"]);
    expect(names(registry.definitionsFor("anthropic"))).toEqual(["Read", "Bash", "Grep"]);
  });

  test("runTool 拒绝集合外工具，工具不执行", async () => {
    const bash = counting("Bash");
    const registry = new ToolRegistry().register(bash);
    const result = await runTool(registry, "Bash", {}, { workDir: "/w", allowedTools: new Set(["Read"]) });
    expect(result).toMatchObject({ ok: false, errorKind: "not_allowed" });
    expect(result.content).toContain("不在当前可用工具中");
    expect(bash.calls).toBe(0);
  });

  test("集合内工具照常执行；不传集合时不收窄", async () => {
    const read = counting("Read");
    const registry = new ToolRegistry().register(read);
    expect((await runTool(registry, "Read", {}, { workDir: "/w", allowedTools: new Set(["Read"]) })).ok).toBe(true);
    expect((await runTool(registry, "Read", {}, { workDir: "/w" })).ok).toBe(true);
    expect(read.calls).toBe(2);
  });

  test("集合外的延迟工具不会被自动补载", async () => {
    const registry = new ToolRegistry();
    let loaded = 0;
    registry.registerLazy({ name: "mcp_x", description: "x", loader: async () => { loaded += 1; return counting("mcp_x"); } });
    const result = await runTool(registry, "mcp_x", {}, { workDir: "/w", allowedTools: new Set(["Read"]) });
    expect(result.errorKind).toBe("not_allowed");
    expect(loaded).toBe(0);
    expect(registry.lazyNames()).toEqual(["mcp_x"]);
  });
});

describe("系统级工具的权限分类（Skill F7）", () => {
  test("system 工具即使不是只读，四个档位兜底都是放行", () => {
    const tool = counting("loadSkill", { readOnly: false, system: true });
    expect(classifyTool(tool)).toBe("read");
    for (const mode of PERMISSION_MODES) expect(MODE_FALLBACK[mode][classifyTool(tool)]).toBe("allow");
  });

  test("非 system 的写工具分类不变", () => {
    expect(classifyTool(counting("Write", { readOnly: false }))).toBe("write");
    expect(classifyTool(counting("Bash", { readOnly: false }))).toBe("bash");
  });
});
