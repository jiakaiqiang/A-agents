import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_FILE_MAX_BYTES } from "../tools/limits.js";
import { parseSkill } from "./parser.js";
import type { SkillDef, SkillLoadResult, SkillSource } from "./types.js";

/** 内部样板随源码发布，和外部 Skill 走同一个解析器（plan「技术决策」）。 */
export function builtinSkillsDir(): string {
  return fileURLToPath(new URL("./builtin", import.meta.url));
}

interface Candidate {
  name: string;
  path: string;
}

/** 解析后的真实路径必须仍在 skills 目录内：挡住指向目录外的符号链接（spec N5）。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 只看第一层：`<名字>.md` 与 `<名字>/SKILL.md`（spec F3）。同名并存时目录型优先。 */
function candidates(dir: string, warnings: string[]): Candidate[] {
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
      files.set(entry.name.slice(0, -3), join(dir, entry.name));
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      const entryFile = join(dir, entry.name, "SKILL.md");
      if (existsSync(entryFile)) dirs.set(entry.name, entryFile);
    }
  }
  const result: Candidate[] = [...dirs].map(([name, path]) => ({ name, path }));
  for (const [name, path] of files) {
    if (dirs.has(name)) warnings.push(`${path}：与 ${dirs.get(name)} 并存，使用目录型`);
    else result.push({ name, path });
  }
  return result;
}

function scanDir(dir: string, source: SkillSource, warnings: string[]): SkillDef[] {
  if (!existsSync(dir)) return [];
  const skills: SkillDef[] = [];
  let list: Candidate[];
  try {
    list = candidates(dir, warnings);
  } catch (error) {
    warnings.push(`${dir}：无法读取 skills 目录（${error instanceof Error ? error.message : String(error)}）`);
    return [];
  }
  for (const candidate of list) {
    // 单个文件出任何问题都只跳过它自己（spec N4）。
    try {
      if (!isInside(dir, candidate.path)) {
        warnings.push(`${candidate.path}：指向 skills 目录之外，已跳过`);
        continue;
      }
      if (statSync(candidate.path).size > SKILL_FILE_MAX_BYTES) {
        warnings.push(`${candidate.path}：超过 ${SKILL_FILE_MAX_BYTES / 1024}KB，已跳过`);
        continue;
      }
      const parsed = parseSkill(readFileSync(candidate.path, "utf8"), { dirName: candidate.name, source, path: candidate.path });
      if (!parsed.ok) {
        warnings.push(`${candidate.path}：${parsed.reason}`);
        continue;
      }
      for (const warning of parsed.warnings) warnings.push(`${candidate.path}：${warning}`);
      skills.push(parsed.skill);
    } catch (error) {
      warnings.push(`${candidate.path}：读取失败（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  return skills;
}

/**
 * 三级发现（spec F3、F4）：内部 → 用户 → 项目依次写入同一张表，后写覆盖先写；
 * 覆盖完成后再做白名单校验，被覆盖的低层 Skill 不会因白名单问题产生多余告警。
 */
export function loadSkills(options: {
  workDir: string;
  homeDir: string;
  availableTools: ReadonlySet<string>;
  builtinDir?: string;
}): SkillLoadResult {
  const warnings: string[] = [];
  const byName = new Map<string, SkillDef>();
  const layers: Array<[string, SkillSource]> = [
    [options.builtinDir ?? builtinSkillsDir(), "builtin"],
    [join(options.homeDir, ".mewcode", "skills"), "user"],
    [join(options.workDir, ".mewcode", "skills"), "project"],
  ];
  for (const [dir, source] of layers) {
    for (const skill of scanDir(dir, source, warnings))byName .set(skill.name, skill);
  }

  for (const [name, skill] of byName) {
    const missing = (skill.tools ?? []).filter((tool) => !options.availableTools.has(tool));
    if (missing.length) {
      warnings.push(`${skill.path}：白名单包含不存在的工具 ${missing.join("、")}，本次未加载`);
      byName.delete(name);
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const counts: Record<SkillSource, number> = { builtin: 0, user: 0, project: 0 };
  for (const skill of skills) counts[skill.source] += 1;
  return { skills, warnings, counts };
}
