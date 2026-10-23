import { expect, test } from "bun:test";
import { parseInput } from "../../src/commands/parser.js";

test("空白输入早返回", () => {
  expect(parseInput("")).toEqual({ type: "empty" });
  expect(parseInput("   \n ")).toEqual({ type: "empty" });
});

test("非斜杠开头是普通文本", () => {
  expect(parseInput("  hello /x ")).toEqual({ type: "text", text: "hello /x" });
});

test("命令名转小写，参数去首尾空白", () => {
  expect(parseInput("/HELP")).toEqual({ type: "command", name: "help", args: "" });
  expect(parseInput("/help   status ")).toEqual({ type: "command", name: "help", args: "status" });
});

test("换行也是命令名的边界，参数保留内部换行", () => {
  expect(parseInput("/review a\nb")).toEqual({ type: "command", name: "review", args: "a\nb" });
  expect(parseInput("/review\nsrc")).toEqual({ type: "command", name: "review", args: "src" });
});

test("只有斜杠或斜杠后紧跟空白时命令名为空", () => {
  expect(parseInput("/")).toEqual({ type: "command", name: "", args: "" });
  expect(parseInput("/ foo")).toEqual({ type: "command", name: "", args: "foo" });
});
