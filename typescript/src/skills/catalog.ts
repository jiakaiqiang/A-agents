import { SKILL_CATALOG_DESC_MAX_CHARS } from "../tools/limits.js";
import type { ActiveSkill, SkillDef } from "./types.js";

function shorten(text: string): string {
  return text.length > SKILL_CATALOG_DESC_MAX_CHARS ? `${text.slice(0, SKILL_CATALOG_DESC_MAX_CHARS - 1)}…` : text;
}

/**
 * 第一阶段目录（spec F6、N1）：只列名字和一句说明，进系统提示词稳定段。
 * 会话内不变，所以不会让稳定段缓存失效（spec N2）。
 */
export function skillCatalogSection(skills: SkillDef[]): string {
  if (!skills.length) return "";
  return [
    "# Skills",
    "以下 Skill 可用。用户的请求匹配某个 Skill 时，调用 loadSkill({\"name\": \"<名字>\", \"args\": \"<参数>\"}) 加载其完整指令；用户也可以输入 /<名字> 直接调用。",
    ...skills.map((skill) => `- ${skill.name}: ${shorten(skill.description)}${skill.mode === "isolated" ? "（独立运行）" : ""}`),
  ].join("\n");
}

/** 钉住区（spec F8）：已激活 Skill 替换参数后的全文，按激活顺序排列。 */
export function pinnedSection(active: ActiveSkill[]): string {
  if (!active.length) return "";
  return [
    "<active-skills>",
    "以下 Skill 已激活，按其指令执行，直到用户停用：",
    ...active.map((item) => `## Skill: ${item.skill.name}\n${item.expanded}`),
    "</active-skills>",
  ].join("\n");
}
