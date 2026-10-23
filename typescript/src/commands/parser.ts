import type { ParsedInput } from "./types.js";

/**
 * 解析一次回车提交（spec F3）：斜杠后到第一个空白字符（含换行）前为命令名，转小写；
 * 其余去首尾空白为参数原文。
 */
export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (!text) return { type: "empty" };
  if (!text.startsWith("/")) return { type: "text", text };
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(text)!;
  return { type: "command", name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}
