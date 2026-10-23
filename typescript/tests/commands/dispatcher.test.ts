import { describe, expect, test } from "bun:test";
import { dispatch, expandPrompt } from "../../src/commands/dispatcher.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import type { CommandDef, PromptCommand } from "../../src/commands/types.js";
import { fakeUI, messages } from "./fake-ui.js";

let runs: string[] = [];

const review: PromptCommand = {
  kind: "prompt", name: "review", aliases: [], description: "审查", usage: "/review [范围]",
  availableWhileBusy: false, argHint: "[范围]", argLabel: "审查范围", template: "请审查改动",
};

const defs: CommandDef[] = [
  { kind: "local", name: "status", aliases: ["st"], description: "", usage: "/status", availableWhileBusy: true, run: ({ args }) => { runs.push(`status:${args}`); } },
  { kind: "ui", name: "clear", aliases: [], description: "", usage: "/clear", availableWhileBusy: false, run: () => { runs.push("clear"); } },
  { kind: "local", name: "help", aliases: [], description: "", usage: "/help [命令名]", availableWhileBusy: true, argHint: "[命令名]", run: ({ args }) => { runs.push(`help:${args}`); } },
  { kind: "local", name: "boom", aliases: [], description: "", usage: "/boom", availableWhileBusy: true, run: () => { throw new Error("同步炸了"); } },
  { kind: "local", name: "later", aliases: [], description: "", usage: "/later", availableWhileBusy: true, run: async () => { throw new Error("异步炸了"); } },
  review,
];

function setup() {
  runs = [];
  const registry = new CommandRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

describe("dispatch 分流", () => {
  test("普通文本交回调用方，不触碰界面", () => {
    const { ui, calls } = fakeUI();
    expect(dispatch("hello", { registry: setup(), ui, busy: false })).toBe("not-command");
    expect(calls).toEqual([]);
  });

  test("未知命令带 /help 引导，不执行任何命令", () => {
    const { ui, calls } = fakeUI();
    expect(dispatch("/nope", { registry: setup(), ui, busy: false })).toBe("done");
    expect(messages(calls)).toEqual(["未知命令：/nope，输入 /help 查看可用命令"]);
    expect(dispatch("/", { registry: setup(), ui, busy: false })).toBe("done");
    expect(messages(calls)[1]).toContain("未知命令：/，");
    expect(runs).toEqual([]);
  });

  test("命令名大小写不敏感，别名等价", () => {
    const { ui } = fakeUI();
    const registry = setup();
    dispatch("/STATUS", { registry, ui, busy: false });
    dispatch("/st", { registry, ui, busy: false });
    expect(runs).toEqual(["status:", "status:"]);
  });
});

describe("dispatch 运行中与参数校验", () => {
  test("运行中不可用的命令被拒绝并保留输入", () => {
    const { ui, calls } = fakeUI();
    expect(dispatch("/clear", { registry: setup(), ui, busy: true })).toBe("rejected");
    expect(messages(calls)).toEqual(["Agent 运行中，请稍后或按 Esc 中断"]);
    expect(runs).toEqual([]);
  });

  test("运行中可用的命令照常执行", () => {
    const { ui } = fakeUI();
    expect(dispatch("/status", { registry: setup(), ui, busy: true })).toBe("done");
    expect(runs).toEqual(["status:"]);
  });

  test("不接受参数的命令收到参数时显示用法，不执行", () => {
    const { ui, calls } = fakeUI();
    expect(dispatch("/status foo", { registry: setup(), ui, busy: false })).toBe("done");
    expect(messages(calls)).toEqual(["用法：/status"]);
    expect(runs).toEqual([]);
  });

  test("接受参数的命令拿到去空白后的参数", () => {
    const { ui } = fakeUI();
    dispatch("/help   clear ", { registry: setup(), ui, busy: false });
    expect(runs).toEqual(["help:clear"]);
  });
});

describe("dispatch 提示词类", () => {
  test("显示原命令，模型收到展开文本", () => {
    const { ui, calls } = fakeUI();
    expect(dispatch(" /review src/tui ", { registry: setup(), ui, busy: false })).toBe("done");
    expect(calls).toEqual([{ method: "sendUserMessage", args: ["/review src/tui", "请审查改动\n\n审查范围：src/tui"] }]);
  });

  test("客户端未就绪时保留输入", () => {
    const { ui } = fakeUI({ sendUserMessage: () => false });
    expect(dispatch("/review", { registry: setup(), ui, busy: false })).toBe("rejected");
  });

  test("expandPrompt 无参返回模板原文；无 argLabel 时直接追加参数", () => {
    expect(expandPrompt(review, "")).toBe("请审查改动");
    expect(expandPrompt({ ...review, argLabel: undefined }, "x")).toBe("请审查改动\n\nx");
  });
});

describe("dispatch 异常兜底", () => {
  test("同步抛错转为错误消息", () => {
    const { ui, calls } = fakeUI();
    expect(dispatch("/boom", { registry: setup(), ui, busy: false })).toBe("done");
    expect(messages(calls)).toEqual(["命令 /boom 执行失败：同步炸了"]);
  });

  test("异步失败转为错误消息，dispatch 本身不抛", async () => {
    const { ui, calls } = fakeUI();
    expect(dispatch("/later", { registry: setup(), ui, busy: false })).toBe("done");
    await Bun.sleep(0);
    expect(messages(calls)).toEqual(["命令 /later 执行失败：异步炸了"]);
  });
});
