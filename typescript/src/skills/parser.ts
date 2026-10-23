import { load } from "js-yaml";
import type { ParseResult, SkillMode, SkillSource } from "./types.js";

/** 名字只允许小写字母、数字、连字符，且要能直接当斜杠命令名（spec F1）。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const KNOWN_FIELDS = new Set(["name", "description", "tools", "mode", "history", "model"]);
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析单个 Skill 文件（spec F1）。失败只返回原因，由加载器决定跳过并告警；
 * js-yaml 4 的默认 schema 不含可执行类型，解析不会执行任何代码（spec N5）。
 */
export function parseSkill(text: string, meta: { dirName: string; source: SkillSource; path: string }): ParseResult {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (!match) return { ok: false, reason: "缺少 frontmatter（文件需以 --- 开头的 YAML 段落起始）" };

  let data: unknown;
  try {
    data = load(match[1]!);
  } catch (error) {
    return { ok: false, reason: `frontmatter 不是合法 YAML：${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
  if (!isObject(data)) return { ok: false, reason: "frontmatter 不是合法 YAML：顶层必须是键值对" };

  const { name, description, tools, mode = "shared", history, model } = data;
  if (typeof name !== "string" || !name) return { ok: false, reason: "缺少必填字段 name" };
  if (!SKILL_NAME_PATTERN.test(name)) return { ok: false, reason: `name 不合法：${JSON.stringify(name)}（只允许小写字母、数字、连字符）` };
  if (name !== meta.dirName) return { ok: false, reason: `name「${name}」与文件名或目录名「${meta.dirName}」不一致` };
  if (typeof description !== "string" || !description.trim()) return { ok: false, reason: "缺少必填字段 description" };
  if (/[\r\n]/.test(description.trim())) return { ok: false, reason: "description 只能是一行" };
  if (tools !== undefined && tools !== null && (!Array.isArray(tools) || !tools.every((item) => typeof item === "string" && item.trim()))) {
    return { ok: false, reason: "tools 必须是工具名列表" };
  }
  if (mode !== "shared" && mode !== "isolated") return { ok: false, reason: `mode 只能是 shared 或 isolated，实际为 ${JSON.stringify(mode)}` };
  if (history !== undefined && (typeof history !== "number" || !Number.isInteger(history) || history < 0)) {
    return { ok: false, reason: "history 必须是非负整数" };
  }
  if (model !== undefined && (typeof model !== "string" || !model.trim())) return { ok: false, reason: "model 必须是非空字符串" };

  const body = normalized.slice(match[0].length).trim();
  if (!body) return { ok: false, reason: "正文为空" };

  const warnings: string[] = [];
  for (const key of Object.keys(data)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`未知字段 ${key}，已忽略`);
  }
  const isolated = (mode as SkillMode) === "isolated";
  if (!isolated && history !== undefined) warnings.push("共享模式忽略 history");
  if (!isolated && model !== undefined) warnings.push("共享模式忽略 model");

  return {
    ok: true,
    warnings,
    skill: {
      name,
      description: description.trim(),
      tools: Array.isArray(tools) ? tools.map((item) => (item as string).trim()) : null,
      mode: mode as SkillMode,
      history: isolated ? (history as number | undefined) ?? 0 : 0,
      ...(isolated && typeof model === "string" ? { model: model.trim() } : {}),
      body,
      source: meta.source,
      path: meta.path,
    },
  };
}

/** 参数替换（spec F2）：替换全部 $ARGUMENTS；没有占位符而传了参数时追加到末尾。 */
export function expandBody(body: string, args: string): string {
  const value = args.trim();
  // 用函数形式替换：参数里的 $&、$1 等不会被当成替换模式。
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", () => value);
  return value ? `${body.trimEnd()}\n\n${value}` : body;
}
