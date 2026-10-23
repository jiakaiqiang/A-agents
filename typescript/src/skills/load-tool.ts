import { fail, ok, stringArg, type Tool } from "../tools/types.js";
import { resultMessage } from "./isolated.js";
import { LOAD_SKILL_TOOL, type SkillManager } from "./manager.js";

/**
 * 第二阶段加载工具（spec F7）：模型按目录选定 Skill 后调用它。
 * readOnly 为 false：不与读工具并发，独立子对话里的确认框同一时刻最多一个；
 * system 为 true：权限按读类兜底，加载本身任何档位都不询问（plan「技术决策」）。
 */
export function createLoadSkillTool(manager: SkillManager): Tool {
  return {
    name: LOAD_SKILL_TOOL,
    description:
      "加载一个 Skill 的完整指令。传入 Skill 目录里的名字与可选参数：共享 Skill 会被激活，其指令从下一步起常驻上下文；" +
      "独立 Skill 会在子对话里跑完，返回结果摘要。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill 名字（来自 Skills 目录）" },
        args: { type: "string", description: "传给 Skill 的参数，替换其指令中的 $ARGUMENTS；可省略" },
      },
      required: ["name"],
    },
    readOnly: false,
    system: true,
    callSummary(args) {
      return `loadSkill(${String(args.name ?? "")})`;
    },
    async execute(args, context) {
      const name = stringArg(args, "name").trim();
      const params = stringArg(args, "args");
      const skill = manager.get(name);
      if (!skill) {
        const names = manager.list().map((item) => item.name);
        return fail("not_found", `未找到 Skill ${name || "（空）"}。可用：${names.length ? names.join("、") : "无"}`);
      }
      try {
        if (skill.mode === "shared") {
          manager.activate(name, params);
          const allowed = manager.allowedTools();
          const tools = allowed ? [...allowed].join("、") : "全部工具";
          return ok(`已激活 Skill ${name}，完整指令已加入上下文，从下一步起按其执行。当前可用工具：${tools}。`, `loadSkill(${name} 已激活)`);
        }
        const outcome = await manager.runIsolated(name, params, context);
        const text = resultMessage(name, outcome);
        return outcome.ok ? ok(text, `loadSkill(${name} 完成)`) : fail("exec_failed", text);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return fail("exec_failed", `Skill ${name} 执行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
