import { describe, expect, test } from "bun:test";
import { BUILTIN_COMMANDS, createBuiltinRegistry } from "../../src/commands/builtins/index.js";
import { dispatch } from "../../src/commands/dispatcher.js";
import { fakeUI, messages, mutations, type UICall } from "./fake-ui.js";

const registry = createBuiltinRegistry();

function run(text: string, busy = false) {
  const { ui, calls } = fakeUI();
  const result = dispatch(text, { registry, ui, busy });
  return { result, calls };
}

const methods = (calls: UICall[]) => calls.map((call) => call.method);

describe("内置命令登记", () => {
  test("14 个主名无冲突（/review 由 Skill 取代，新增 /skills）", () => {
    expect(registry.list().map((def) => def.name).sort()).toEqual([
      "accept-edits", "bypass", "clear", "compact", "do", "exit", "help", "memory", "permission", "plan", "resume", "session", "skills", "status",
    ]);
    expect(BUILTIN_COMMANDS).toHaveLength(14);
  });

  test("每条命令都有描述与以斜杠开头的用法", () => {
    for (const def of BUILTIN_COMMANDS) {
      expect(def.description.trim()).not.toBe("");
      expect(def.usage.startsWith(`/${def.name}`)).toBe(true);
    }
  });
});

describe("内置命令行为（假界面，不启动 TUI）", () => {
  test("14 条命令逐条执行不抛错", async () => {
    for (const def of BUILTIN_COMMANDS) {
      const { result, calls } = run(`/${def.name}`);
      expect(result).toBe("done");
      await Bun.sleep(0);
      expect(messages(calls).some((text) => text.includes("执行失败"))).toBe(false);
    }
  });

  test("只读命令只展示、不改状态", () => {
    for (const name of ["help", "status", "session", "memory", "permission"]) {
      const { calls } = run(`/${name}`);
      expect(mutations(calls)).toEqual([]);
      expect(messages(calls)).toHaveLength(1);
    }
  });

  test("/h 与 /help 输出一致，/help 含别名", () => {
    expect(messages(run("/h").calls)).toEqual(messages(run("/help").calls));
    expect(messages(run("/help").calls)[0]).toContain("（别名 /quit, /q）");
  });

  test("/q、/quit、/exit 等价", () => {
    for (const text of ["/q", "/quit", "/exit", "/EXIT"]) expect(methods(run(text).calls)).toEqual(["exit"]);
  });

  test("四个模式命令切到对应档位并刷新状态栏", () => {
    const cases: Array<[string, string]> = [["/plan", "plan"], ["/do", "default"], ["/accept-edits", "acceptEdits"], ["/bypass", "bypass"]];
    for (const [text, mode] of cases) {
      expect(run(text).calls).toEqual([{ method: "setPermissionMode", args: [mode] }, { method: "refreshStatus", args: [] }]);
    }
  });

  test("/clear、/compact、/resume 调用对应界面能力", () => {
    expect(methods(run("/clear").calls)).toEqual(["clearConversation"]);
    expect(methods(run("/compact").calls)).toEqual(["compact"]);
    expect(methods(run("/resume").calls)).toEqual(["openResume"]);
  });

  test("/status foo 显示用法，不执行", () => {
    const { calls } = run("/status foo");
    expect(messages(calls)).toEqual(["用法：/status"]);
    expect(methods(calls)).toEqual(["showMessage"]);
  });
});

describe("运行中可用性", () => {
  test("/clear、/compact 被拒绝", () => {
    for (const text of ["/clear", "/compact"]) {
      const { result, calls } = run(text, true);
      expect(result).toBe("rejected");
      expect(messages(calls)).toEqual(["Agent 运行中，请稍后或按 Esc 中断"]);
    }
  });

  test("只读、切档、恢复、退出照常执行", () => {
    for (const text of ["/status", "/help", "/plan", "/do", "/resume", "/exit"]) expect(run(text, true).result).toBe("done");
  });
});
