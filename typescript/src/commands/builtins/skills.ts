import { createLoadSkillTool } from "../../skills/load-tool.js";
import { loadSkills } from "../../skills/loader.js";
import { LOAD_SKILL_TOOL, SkillManager } from "../../skills/manager.js";
import type { SkillDef, SkillSource } from "../../skills/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { formatSkills } from "../format.js";
import type { CommandRegistry } from "../registry.js";
import type { CommandDef } from "../types.js";

/** 把一个 Skill 变成同名斜杠命令（Skill spec F5）：会发起一轮对话，所以运行中不可用。 */
export function skillCommand(skill: SkillDef): CommandDef {
  return {
    kind: "ui", name: skill.name, aliases: [],
    description: `${skill.description}（Skill）`,
    usage: `/${skill.name} [参数]`, argHint: "[参数]", availableWhileBusy: false,
    run: ({ args, ui }) => {
      const display = args ? `/${skill.name} ${args}` : `/${skill.name}`;
      if (!ui.invokeSkill(skill.name, args, display)) ui.showMessage("LLM 客户端尚未就绪，请稍后重试。", true);
    },
  };
}

/** 登记 Skill 命令；与内置命令名称或别名冲突的 Skill 剔除并告警，内置命令不变（Skill spec F5）。 */
export function registerSkillCommands(registry: CommandRegistry, skills: SkillDef[]): { accepted: SkillDef[]; warnings: string[] } {
  const accepted: SkillDef[] = [];
  const warnings: string[] = [];
  for (const skill of skills) {
    const owner = registry.resolve(skill.name);
    if (owner) {
      warnings.push(`${skill.path}：与内置命令 /${owner.name} 重名，已跳过`);
      continue;
    }
    registry.register(skillCommand(skill));
    accepted.push(skill);
  }
  return { accepted, warnings };
}

/** /skills：查看与停用（Skill spec F12）。只读或停用，运行中也可用：停用在下一次迭代生效。 */
export const SKILLS_COMMAND: CommandDef = {
  kind: "ui", name: "skills", aliases: [], description: "查看可用 Skill，或停用已激活的 Skill",
  usage: "/skills [off [名字]]", argHint: "[off [名字]]", availableWhileBusy: true,
  run: ({ args, ui }) => {
    const [action, name, ...rest] = args.split(/\s+/).filter(Boolean);
    if (!action) {
      ui.showMessage(formatSkills(ui.listSkills()));
      return;
    }
    if (action !== "off" || rest.length) {
      ui.showMessage("用法：/skills [off [名字]]", true);
      return;
    }
    if (!name) {
      const stopped = ui.deactivateSkills();
      ui.showMessage(stopped.length ? `已停用 Skill：${stopped.join("、")}` : "当前没有已激活的 Skill");
      return;
    }
    const item = ui.listSkills().find((skill) => skill.name === name);
    if (!item) {
      ui.showMessage(`未找到 Skill ${name}，输入 /skills 查看可用 Skill`, true);
      return;
    }
    const stopped = ui.deactivateSkills(name);
    ui.showMessage(stopped.length ? `已停用 Skill ${name}` : `Skill ${name} 当前未激活`);
  },
};

const SOURCE_LABELS: Record<SkillSource, string> = { builtin: "内部", user: "用户", project: "项目" };

/**
 * 启动期装配（Skill plan「启动顺序」）：要在 MCP 连接之后调用，白名单校验依赖实际可用的工具。
 * 收成一个函数，main 与 Ink 测试走同一段装配代码。
 */
export function bootstrapSkills(options: {
  registry: ToolRegistry;
  commands: CommandRegistry;
  workDir: string;
  homeDir: string;
  builtinDir?: string;
}): { manager: SkillManager; warnings: string[]; summary: string } {
  const availableTools = new Set([...options.registry.list().map((tool) => tool.name), ...options.registry.lazyNames(), LOAD_SKILL_TOOL]);
  const loaded = loadSkills({ workDir: options.workDir, homeDir: options.homeDir, availableTools, builtinDir: options.builtinDir });
  const { accepted, warnings } = registerSkillCommands(options.commands, loaded.skills);
  const manager = new SkillManager(accepted);
  options.registry.register(createLoadSkillTool(manager));
  const counts: Record<SkillSource, number> = { builtin: 0, user: 0, project: 0 };
  for (const skill of accepted) counts[skill.source] += 1;
  const parts = (Object.keys(counts) as SkillSource[]).map((source) => `${SOURCE_LABELS[source]} ${counts[source]}`);
  return { manager, warnings: [...loaded.warnings, ...warnings], summary: `已加载 Skill ${accepted.length} 个（${parts.join("、")}）` };
}
