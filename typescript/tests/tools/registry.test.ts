import { describe, expect, test } from "bun:test";
import { createDefaultRegistry, runTool, ToolRegistry } from "../../src/tools/index.js";
import { TOOL_RESULT_MAX_CHARS } from "../../src/tools/limits.js";
import type { Tool } from "../../src/tools/types.js";

function names(definitions: Record<string, unknown>[], protocol: string): string[] {
  return definitions.map((definition) => protocol === "openai-compat"
    ? (definition.function as { name: string }).name
    : definition.name as string);
}

function schema(definition: Record<string, unknown>, protocol: string): { required: string[]; properties: Record<string, unknown> } {
  const outer = protocol === "anthropic" ? definition.input_schema : protocol === "openai" ? definition.parameters : (definition.function as { parameters: unknown }).parameters;
  return outer as { required: string[]; properties: Record<string, unknown> };
}

describe("ToolRegistry", () => {
  test("默认注册表包含六个核心工具", () => {
    const registry = createDefaultRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    for (const tool of registry.list()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
    }
  });

  test("三协议导出的名称、描述与参数语义一致", () => {
    const registry = createDefaultRegistry();
    const protocols = ["anthropic", "openai", "openai-compat"] as const;
    const definitions = protocols.map((protocol) => registry.definitionsFor(protocol));
    expect(definitions.map((items) => items.length)).toEqual([6, 6, 6]);
    expect(names(definitions[0], protocols[0])).toEqual(names(definitions[1], protocols[1]));
    expect(names(definitions[0], protocols[0])).toEqual(names(definitions[2], protocols[2]));

    for (let i = 0; i < definitions[0].length; i += 1) {
      const first = definitions[0][i]!;
      const second = definitions[1][i]!;
      const third = definitions[2][i]!;
      expect(first.description).toBe(second.description);
      expect(first.description).toBe((third.function as { description: string }).description);
      expect(schema(first, "anthropic").required).toEqual(schema(second, "openai").required);
      expect(Object.keys(schema(first, "anthropic").properties)).toEqual(Object.keys(schema(third, "openai-compat").properties));
    }
  });

  test("未登记工具返回 unknown_tool", async () => {
    const registry = createDefaultRegistry();
    expect(registry.get("Nope")).toBeUndefined();
    const result = await runTool(registry, "Nope", {}, { workDir: process.cwd() });
    expect(result.errorKind).toBe("unknown_tool");
  });

  test("只读过滤只导出读类工具", () => {
    const registry = createDefaultRegistry();
    expect(registry.listReadOnly().map((tool) => tool.name)).toEqual(["Read", "Glob", "Grep"]);
    expect(registry.list().filter((tool) => !tool.readOnly).map((tool) => tool.name))
      .toEqual(["Write", "Edit", "Bash"]);

    for (const protocol of ["anthropic", "openai", "openai-compat"] as const) {
      const definitions = registry.definitionsFor(protocol, { readOnlyOnly: true });
      expect(definitions).toHaveLength(3);
      expect(names(definitions, protocol)).toEqual(["Read", "Glob", "Grep"]);
      expect(registry.definitionsFor(protocol)).toHaveLength(6);
    }
  });

  test("重复登记在开发期抛错", () => {
    const registry = new ToolRegistry();
    registry.register(createDefaultRegistry().get("Read")!);
    expect(() => registry.register(createDefaultRegistry().get("Read")!)).toThrow();
  });
});

const fakeTool: Tool = {
  name: "Fake",
  description: "test tool",
  parameters: {
    type: "object",
    properties: { value: { type: "string", description: "value" } },
    required: ["value"],
  },
  readOnly: true,
  callSummary: () => "Fake()",
  async execute(args) {
    return { ok: true, content: String(args.value), summary: String(args.value) };
  },
};

describe("runTool", () => {
  test("参数不合法时不执行工具", async () => {
    let called = false;
    const tool: Tool = { ...fakeTool, async execute() { called = true; return { ok: true, content: "x", summary: "x" }; } };
    const registry = new ToolRegistry().register(tool);
    const result = await runTool(registry, "Fake", {}, { workDir: process.cwd() });
    expect(result.errorKind).toBe("invalid_params");
    expect(called).toBe(false);
  });

  test("工具异常被转为 exec_failed", async () => {
    const tool: Tool = { ...fakeTool, async execute() { throw new Error("boom"); } };
    const result = await runTool(new ToolRegistry().register(tool), "Fake", { value: "x" }, { workDir: process.cwd() });
    expect(result.errorKind).toBe("exec_failed");
    expect(result.content).toContain("boom");
  });

  test("content 和 summary 都会脱敏", async () => {
    const result = await runTool(
      new ToolRegistry().register(fakeTool),
      "Fake",
      { value: "sk-abcdefghijklmnopqrstuvwx" },
      { workDir: process.cwd() },
    );
    expect(result.content).toContain("[redacted]");
    expect(result.summary).toContain("[redacted]");
    expect(result.content).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  test("超长 content 会截断", async () => {
    const result = await runTool(
      new ToolRegistry().register(fakeTool),
      "Fake",
      { value: "x".repeat(TOOL_RESULT_MAX_CHARS + 100) },
      { workDir: process.cwd() },
    );
    expect(result.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(result.content).toContain("[truncated:");
  });

  test("新增第七个工具自动出现在三协议定义中", () => {
    const registry = createDefaultRegistry().register(fakeTool);
    expect(registry.definitionsFor("anthropic")).toHaveLength(7);
    expect(registry.definitionsFor("openai")).toHaveLength(7);
    expect(registry.definitionsFor("openai-compat")).toHaveLength(7);
  });
});
