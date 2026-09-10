import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dump, load } from "js-yaml";
import { isPermissionMode } from "./limits.js";
import { parseRule } from "./rules.js";
import type { PermissionMode, Rule, RuleSet, RuleSource } from "./types.js";

export interface PermissionConfigResult {
  mode: PermissionMode;
  rules: RuleSet;
  warnings: string[];
}

const EMPTY_LAYERS = (): RuleSet => ({
  layers: { session: [], local: [], project: [], user: [] },
});

/**
 * 从三层 YAML 各自读取规则，不复用 mergeConfig——合并会丢掉来源分层（plan P5）。
 * 档位字段后读覆盖先读，与现有配置覆盖方向一致（spec F17）。
 */
export function loadPermissionConfig(cwd: string = process.cwd()): PermissionConfigResult {
  const warnings: string[] = [];
  const rules = EMPTY_LAYERS();
  let mode: PermissionMode = "default";

  const files: Array<{ path: string; source: RuleSource }> = [
    { path: join(homedir(), ".mewcode", "config.yaml"), source: "user" },
    { path: join(cwd, ".mewcode", "config.yaml"), source: "project" },
    { path: join(cwd, ".mewcode", "config.local.yaml"), source: "local" },
  ];

  for (const file of files) {
    const layer = readLayer(file.path, file.source);
    warnings.push(...layer.warnings);
    rules.layers[file.source] = layer.rules;
    if (layer.mode !== undefined) mode = layer.mode;
  }

  return { mode, rules, warnings };
}

interface LayerRead {
  rules: Rule[];
  warnings: string[];
  mode?: PermissionMode;
}

function readLayer(filePath: string, source: RuleSource): LayerRead {
  const warnings: string[] = [];
  if (!existsSync(filePath)) return { rules: [], warnings };

  let parsed: unknown;
  try {
    parsed = load(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rules: [], warnings: [`无法解析权限配置 ${filePath}：${message}`] };
  }

  if (parsed === undefined || parsed === null) return { rules: [], warnings };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rules: [], warnings: [`权限配置格式错误：${filePath} 顶层必须是 YAML 对象`] };
  }

  const raw = parsed as Record<string, unknown>;
  let mode: PermissionMode | undefined;
  if (typeof raw.permission_mode === "string") {
    if (isPermissionMode(raw.permission_mode)) mode = raw.permission_mode;
    else warnings.push(`权限档位 '${raw.permission_mode}' 无效，已退回默认档（${filePath}）`);
  }

  if (raw.permissions === undefined) return { rules: [], warnings, mode };
  if (!Array.isArray(raw.permissions)) {
    warnings.push(`permissions 必须是列表（${filePath}）`);
    return { rules: [], warnings, mode };
  }

  const rules: Rule[] = [];
  for (const [index, item] of raw.permissions.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      warnings.push(`permissions[${index}] 必须是单键对象（${filePath}）`);
      continue;
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length !== 1 || (keys[0] !== "allow" && keys[0] !== "deny")) {
      warnings.push(`permissions[${index}] 必须是 allow 或 deny 单键（${filePath}）`);
      continue;
    }
    const effect = keys[0] as "allow" | "deny";
    const text = (item as Record<string, unknown>)[effect];
    if (typeof text !== "string") {
      warnings.push(`permissions[${index}].${effect} 必须是字符串（${filePath}）`);
      continue;
    }
    const rule = parseRule(text, effect, source, index);
    if (!rule) {
      warnings.push(`无法解析规则 '${text}'（${filePath}）`);
      continue;
    }
    rules.push(rule);
  }
  return { rules, warnings, mode };
}

/**
 * 把一条规则追加到项目本地级配置末尾（spec F23、F13）。
 * 写到尾部即本层顺序最后、优先级最高。目录不存在时递归创建。
 */
export function appendLocalRule(rule: Rule, cwd: string = process.cwd()): void {
  const filePath = join(cwd, ".mewcode", "config.local.yaml");
  mkdirSync(dirname(filePath), { recursive: true });

  let raw: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = load(readFileSync(filePath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
  }

  const permissions = Array.isArray(raw.permissions) ? [...raw.permissions] : [];
  permissions.push({ [rule.effect]: `${rule.tool}(${rule.pattern})` });
  raw.permissions = permissions;
  writeFileSync(filePath, dump(raw), "utf8");
}
