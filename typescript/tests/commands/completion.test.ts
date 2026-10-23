import { expect, test } from "bun:test";
import { suggest } from "../../src/commands/completion.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import type { CommandDef } from "../../src/commands/types.js";

function local(name: string, aliases: string[] = [], hidden = false): CommandDef {
  return { kind: "local", name, aliases, description: `${name} 描述`, usage: `/${name}`, availableWhileBusy: true, hidden, run() {} };
}

const registry = new CommandRegistry();
for (const def of [local("status"), local("session"), local("exit", ["quit", "q"]), local("help", ["h"]), local("secret", [], true)]) registry.register(def);

const names = (text: string) => suggest(text, registry).map((item) => item.name);

test("只输入 / 列出全部非隐藏命令", () => {
  expect(names("/")).toEqual(["exit", "help", "session", "status"]);
});

test("前缀匹配，按主名字母序，带描述", () => {
  expect(names("/s")).toEqual(["session", "status"]);
  expect(suggest("/st", registry)).toEqual([{ name: "status", description: "status 描述" }]);
});

test("别名命中时只出现一次主名", () => {
  expect(names("/q")).toEqual(["exit"]);
  expect(names("/qu")).toEqual(["exit"]);
});

test("不区分大小写", () => {
  expect(names("/S")).toEqual(["session", "status"]);
});

test("无匹配、含空白、多行、非斜杠开头时无列表", () => {
  expect(names("/zz")).toEqual([]);
  expect(names("/st ")).toEqual([]);
  expect(names("/a\nb")).toEqual([]);
  expect(names("st")).toEqual([]);
});

test("隐藏命令即使前缀命中也不出现", () => {
  expect(names("/sec")).toEqual([]);
});
