import type { CommandDef } from "./types.js";

const NAME_PATTERN = /^[a-z0-9-]+$/;

/** 登记阶段的失败：撞名、名称非法、缺执行逻辑或模板（spec F2）。 */
export class CommandRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRegistryError";
  }
}

/** 命令注册中心：启动期一次性登记，之后只读查找（spec F1、F2、F11）。 */
export class CommandRegistry {
  private readonly defs: CommandDef[] = [];
  // 小写名称/别名 → 命令；名称与别名共用一个命名空间。
  private readonly index = new Map<string, CommandDef>();

  register(def: CommandDef): void {
    // 先查冲突再校验格式：仅大小写不同的撞名也要报出双方（spec AC2）。
    const keys = [def.name, ...def.aliases];
    const seen = new Set<string>();
    for (const key of keys) {
      const lower = key.toLowerCase();
      const owner = this.index.get(lower);
      if (owner || seen.has(lower)) {
        throw new CommandRegistryError(`命令名冲突：/${lower} 同时属于 /${owner?.name ?? def.name} 与 /${def.name}`);
      }
      seen.add(lower);
    }
    for (const key of keys) {
      if (!NAME_PATTERN.test(key)) throw new CommandRegistryError(`命令 /${def.name} 的名称或别名不合法：${JSON.stringify(key)}`);
    }
    // 类型系统已约束，这里兜底绕过类型检查的调用方。
    const complete = def.kind === "prompt" ? typeof def.template === "string" && def.template.trim() !== "" : typeof def.run === "function";
    if (!complete) throw new CommandRegistryError(`命令 /${def.name} 缺少执行逻辑或模板`);

    this.defs.push(def);
    for (const key of seen) this.index.set(key, def);
  }

  /** 按名称或别名查找，不区分大小写。 */
  resolve(token: string): CommandDef | undefined {
    return this.index.get(token.toLowerCase());
  }

  /** 按主名字母序列出；默认排除隐藏命令。 */
  list(includeHidden = false): CommandDef[] {
    return this.defs
      .filter((def) => includeHidden || !def.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
