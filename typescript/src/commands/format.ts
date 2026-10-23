// 只读命令的展示文本（spec F12、N5）。纯函数，便于脱离界面单测。

import { NOTE_TYPE_LABELS } from "../memory/notes.js";
import type { PermissionMode, RuleSource } from "../permission/types.js";
import type { CommandRegistry } from "./registry.js";
import type { CommandDef, SkillListItem, StatusSnapshot, UsageSnapshot } from "./types.js";

/** 状态栏与 /status 共用的档位标签（spec F9）。 */
export const MODE_TAGS: Record<PermissionMode, string> = {
  plan: "[PLAN]",
  default: "[DEFAULT]",
  acceptEdits: "[ACCEPT-EDITS]",
  bypass: "[BYPASS]",
};

const RULE_LAYERS: Array<[RuleSource, string]> = [["session", "会话"], ["local", "本地"], ["project", "项目"], ["user", "用户"]];

/** 端点只显示主机名：兼容端点可能把令牌拼在查询串或路径里（spec N5）。 */
export function endpointHost(baseUrl: string): string {
  if (!baseUrl.trim()) return "默认端点";
  try {
    return new URL(baseUrl).host || "（地址无法解析）";
  } catch {
    return "（地址无法解析）";
  }
}

function aliasText(def: CommandDef): string {
  return def.aliases.length ? `（别名 ${def.aliases.map((alias) => `/${alias}`).join(", ")}）` : "";
}

export function formatHelp(registry: CommandRegistry, target?: string): string {
  if (target) {
    const def = registry.resolve(target.replace(/^\//, ""));
    if (!def) return `未知命令：/${target.replace(/^\//, "")}，输入 /help 查看可用命令`;
    const lines = [`/${def.name}${aliasText(def)} — ${def.description}`, `用法：${def.usage}`];
    if (def.argHint) lines.push(`参数：${def.argHint}`);
    return lines.join("\n");
  }
  const defs = registry.list();
  const width = Math.max(...defs.map((def) => def.name.length)) + 1;
  return ["可用命令：", ...defs.map((def) => `  /${def.name.padEnd(width)} ${def.description}${aliasText(def)}`), "输入 /help <命令名> 查看用法"].join("\n");
}

export function formatStatus(snapshot: StatusSnapshot, usage: UsageSnapshot): string {
  const { provider } = snapshot;
  const context = usage.usedTokens === null
    ? "上下文估算未就绪"
    : `上下文约 ${usage.usedTokens}/${usage.contextWindow} tokens（${usage.contextWindow > 0 ? Math.round((usage.usedTokens / usage.contextWindow) * 100) : 0}%）`;
  const connected = snapshot.mcp.filter((report) => report.status === "ok").length;
  return [
    `Provider：${provider.name}（${provider.protocol}）`,
    `模型：${provider.model}`,
    `端点：${endpointHost(provider.baseUrl)}`,
    `档位：${MODE_TAGS[snapshot.permissionMode]}`,
    `最近一次 Token：输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存读取 ${usage.cacheReadTokens} · 缓存写入 ${usage.cacheCreationTokens}`,
    context,
    `MCP ${connected}/${snapshot.mcp.length} 已连接`,
  ].join("\n");
}

export function formatSession(snapshot: StatusSnapshot): string {
  const { session } = snapshot;
  return [`会话 ID：${session.id}`, `消息条数：${session.messageCount}`, `存档路径：${session.path}`, "可用 /resume 切换历史会话"].join("\n");
}

export function formatMemory(snapshot: StatusSnapshot): string {
  const { user, project } = snapshot.memory;
  if (!user.length && !project.length) return "暂无记忆";
  const section = (title: string, notes: StatusSnapshot["memory"]["user"]) => [
    `${title}：`,
    ...(notes.length ? notes.map((note) => `  ${note.name}（${NOTE_TYPE_LABELS[note.type]}）— ${note.description}`) : ["  无"]),
  ];
  return [...section("用户级", user), ...section("项目级", project)].join("\n");
}

const SKILL_SOURCE_LABELS: Record<SkillListItem["source"], string> = { builtin: "内部", user: "用户", project: "项目" };

/** /skills 列表（Skill spec F12）：名字、说明、模式、来源，已激活的标出来。 */
export function formatSkills(items: SkillListItem[]): string {
  if (!items.length) return "暂无可用 Skill";
  const width = Math.max(...items.map((item) => item.name.length)) + 1;
  return [
    "可用 Skill：",
    ...items.map((item) => `  ${item.name.padEnd(width)} ${item.description}  ${item.mode === "isolated" ? "独立" : "共享"}  ${SKILL_SOURCE_LABELS[item.source]}${item.active ? "  ● 已激活" : ""}`),
    "输入 /<名字> [参数] 调用；/skills off [名字] 停用",
  ].join("\n");
}

export function formatPermission(snapshot: StatusSnapshot): string {
  const lines = [`当前档位：${MODE_TAGS[snapshot.permissionMode]}`];
  for (const [source, title] of RULE_LAYERS) {
    const rules = snapshot.rules.layers[source];
    lines.push(`${title}规则：`);
    if (!rules.length) lines.push("  无");
    for (const rule of rules) lines.push(`  ${rule.effect} ${rule.tool}(${rule.pattern})`);
  }
  return lines.join("\n");
}
