import type { ToolContext } from "../tools/types.js";
import { pinnedSection } from "./catalog.js";
import { expandBody } from "./parser.js";
import type { ActiveSkill, IsolatedOutcome, IsolatedRunner, SkillDef } from "./types.js";

/** 系统级加载工具的名字：白名单收窄时始终保留（spec F7、F10）。 */
export const LOAD_SKILL_TOOL = "loadSkill";

/**
 * Skill 运行期状态：全部可用 Skill 与已激活集合（spec F7、F8、F10、F12）。
 * Agent 循环每次迭代都经 pinnedText / allowedTools 读一次，激活变化下一次迭代即生效。
 */
export class SkillManager {
  private readonly skills = new Map<string, SkillDef>();
  // Map 的插入顺序即激活顺序；对已存在的键 set 会原位替换，不改变位置（spec F8）。
  private readonly active = new Map<string, ActiveSkill>();
  private runner: IsolatedRunner | null = null;

  constructor(skills: SkillDef[]) {
    for (const skill of skills) this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDef | undefined {
    return this.skills.get(name);
  }

  list(): SkillDef[] {
    return [...this.skills.values()];
  }

  isActive(name: string): boolean {
    return this.active.has(name);
  }

  activate(name: string, args: string): ActiveSkill {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`未找到 Skill ${name}`);
    if (skill.mode !== "shared") throw new Error(`Skill ${name} 是独立模式，不能激活`);
    const item: ActiveSkill = { skill, expanded: expandBody(skill.body, args) };
    this.active.set(name, item);
    return item;
  }

  /** 不传名字时停用全部；返回实际停用的名字。 */
  deactivate(name?: string): string[] {
    if (name === undefined) {
      const names = [...this.active.keys()];
      this.active.clear();
      return names;
    }
    return this.active.delete(name) ? [name] : [];
  }

  pinnedText(): string {
    return pinnedSection([...this.active.values()]);
  }

  /** 已激活白名单的并集 + 加载工具；没有激活、或任一已激活 Skill 没写白名单时不收窄（spec F10）。 */
  allowedTools(): ReadonlySet<string> | null {
    if (!this.active.size) return null;
    const allowed = new Set<string>([LOAD_SKILL_TOOL]);
    for (const { skill } of this.active.values()) {
      if (!skill.tools) return null;
      for (const tool of skill.tools) allowed.add(tool);
    }
    return allowed;
  }

  setIsolatedRunner(runner: IsolatedRunner): void {
    this.runner = runner;
  }

  async runIsolated(name: string, args: string, context: ToolContext): Promise<IsolatedOutcome> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`未找到 Skill ${name}`);
    if (skill.mode !== "isolated") throw new Error(`Skill ${name} 是共享模式，不能独立运行`);
    if (!this.runner) return { ok: false, text: "独立模式运行器未就绪" };
    return this.runner(skill, args, context);
  }
}
