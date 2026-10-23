import { describe, expect, test } from "bun:test";
import { CommandRegistry, CommandRegistryError } from "../../src/commands/registry.js";
import type { CommandDef } from "../../src/commands/types.js";

function local(name: string, aliases: string[] = [], extra: Partial<CommandDef> = {}): CommandDef {
  return { kind: "local", name, aliases, description: `${name} 描述`, usage: `/${name}`, availableWhileBusy: true, run() {}, ...extra } as CommandDef;
}

function registerAll(...defs: CommandDef[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

describe("CommandRegistry 登记与查找", () => {
  test("按名称与别名查找，不区分大小写", () => {
    const registry = registerAll(local("help", ["h"]));
    expect(registry.resolve("help")?.name).toBe("help");
    expect(registry.resolve("h")?.name).toBe("help");
    expect(registry.resolve("HELP")?.name).toBe("help");
    expect(registry.resolve("nope")).toBeUndefined();
  });

  test("list 按主名字母序，默认排除隐藏命令", () => {
    const registry = registerAll(local("status"), local("clear"), local("debug", [], { hidden: true }));
    expect(registry.list().map((def) => def.name)).toEqual(["clear", "status"]);
    expect(registry.list(true).map((def) => def.name)).toEqual(["clear", "debug", "status"]);
  });
});

describe("CommandRegistry 冲突检测", () => {
  const cases: Array<[string, CommandDef[], string[]]> = [
    ["名称撞名称", [local("exit"), local("exit")], ["/exit"]],
    ["名称撞别名", [local("exit", ["q"]), local("q")], ["/exit", "/q"]],
    ["别名撞别名", [local("exit", ["q"]), local("quiet", ["q"])], ["/exit", "/quiet"]],
    ["仅大小写不同", [local("exit", ["q"]), local("query", ["Q"])], ["/exit", "/query"]],
    ["自身名称与别名重复", [local("exit", ["exit"])], ["/exit"]],
  ];
  for (const [label, defs, owners] of cases) {
    test(label, () => {
      let error: unknown;
      try { registerAll(...defs); } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(CommandRegistryError);
      const message = (error as Error).message;
      expect(message).toContain("命令名冲突");
      for (const owner of owners) expect(message).toContain(owner);
    });
  }
});

describe("CommandRegistry 定义校验", () => {
  test.each([["Help"], ["my cmd"], [""]])("名称不合法：%p", (name) => {
    expect(() => registerAll(local(name))).toThrow(/名称或别名不合法/);
  });

  test("别名不合法", () => {
    expect(() => registerAll(local("help", ["?"]))).toThrow(/名称或别名不合法/);
  });

  test("提示词类缺模板", () => {
    const def = { kind: "prompt", name: "review", aliases: [], description: "", usage: "/review", availableWhileBusy: false, template: "  " } as unknown as CommandDef;
    expect(() => registerAll(def)).toThrow(/\/review 缺少执行逻辑或模板/);
  });

  test("本地类缺执行逻辑", () => {
    const def = { kind: "local", name: "status", aliases: [], description: "", usage: "/status", availableWhileBusy: true } as unknown as CommandDef;
    expect(() => registerAll(def)).toThrow(/\/status 缺少执行逻辑或模板/);
  });

  test("登记失败不留下半条索引", () => {
    const registry = new CommandRegistry();
    expect(() => registry.register(local("ok", ["Bad Alias"]))).toThrow();
    expect(registry.resolve("ok")).toBeUndefined();
  });
});
