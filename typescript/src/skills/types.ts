// Skill 系统的类型定义（Skill spec F1–F14）。
// 本模块不依赖界面框架与命令模块：命令层与界面层只经 SkillManager 读写 Skill 状态。

import type { ToolContext } from "../tools/types.js";

/** 来源层级，同名时 project > user > builtin（spec F3）。 */
export type SkillSource = "builtin" | "user" | "project";

/** 执行模式：共享当前对话，或开独立子对话跑完再回流（spec F8、F11）。 */
export type SkillMode = "shared" | "isolated";

export interface SkillDef {
  name: string;
  description: string;
  tools: string[] | null; // null 表示不收窄
  mode: SkillMode;
  history: number; // 仅 isolated 有意义；shared 恒为 0
  model?: string; // 仅 isolated
  body: string; // 未替换参数的 SOP 正文
  source: SkillSource;
  path: string; // 来源文件，用于告警和 /skills 展示
}

/** 单个文件的解析结果：未知字段等只告警，不影响加载（spec F1）。 */
export type ParseResult =
  | { ok: true; skill: SkillDef; warnings: string[] }
  | { ok: false; reason: string };

export interface SkillLoadResult {
  skills: SkillDef[]; // 已覆盖、已校验，按名字排序
  warnings: string[]; // 每条都带路径和原因
  counts: Record<SkillSource, number>; // 启动摘要用（覆盖与校验之后的数量）
}

export interface ActiveSkill {
  skill: SkillDef;
  expanded: string; // 替换参数后的全文，即钉住内容
}

export interface IsolatedOutcome {
  ok: boolean; // 中断或失败时为 false
  text: string; // 子对话最后一条回复，或失败说明
}

/** 独立模式运行器：由界面层注入，负责选客户端、渲染子对话事件（plan「独立模式：模型调用」）。 */
export type IsolatedRunner = (skill: SkillDef, args: string, context: ToolContext) => Promise<IsolatedOutcome>;
