import type { CommandRegistry } from "./registry.js";
import type { Suggestion } from "./types.js";

/**
 * 实时补全的候选（spec F10、F11）：只在单行、以 / 开头、尚无空白时给出。
 * 名称或别名前缀命中即入选；每条命令至多一项，按主名字母序。
 */
export function suggest(text: string, registry: CommandRegistry): Suggestion[] {
  if (!/^\/\S*$/.test(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  return registry.list(false)
    .filter((def) => [def.name, ...def.aliases].some((key) => key.toLowerCase().startsWith(prefix)))
    .map((def) => ({ name: def.name, description: def.description }));
}
