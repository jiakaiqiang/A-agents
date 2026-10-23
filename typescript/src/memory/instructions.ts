import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INCLUDE_MAX_DEPTH, INSTRUCTION_FILE_NAME } from "../tools/limits.js";
import { resolveInside } from "../tools/paths.js";

export interface InstructionSource {
  label: string;
  path: string;
  root: string;
}

export interface InstructionsResult {
  text: string;
  warnings: string[];
}

export function instructionSources(workDir: string, homeDir = homedir()): InstructionSource[] {
  const project = resolve(workDir);
  const user = resolve(homeDir, ".mewcode");
  return [
    { label: "项目根 MEWCODE.md", path: join(project, INSTRUCTION_FILE_NAME), root: project },
    { label: "项目 .mewcode/MEWCODE.md", path: join(project, ".mewcode", INSTRUCTION_FILE_NAME), root: project },
    { label: "用户级 ~/.mewcode/MEWCODE.md", path: join(user, INSTRUCTION_FILE_NAME), root: user },
  ];
}

/** 整次加载共用真实路径集合，环路与跨来源的重复引用都只展开一次。 */
export function loadInstructions(workDir: string, homeDir = homedir()): InstructionsResult {
  const warnings: string[] = [];
  const visited = new Set<string>();

  function expand(path: string, root: string, depth: number): string {
    const safe = resolveInside(root, path);
    if (!safe.ok) {
      warnings.push(`越界引用已拦截：${path}`);
      return "";
    }
    if (depth > INCLUDE_MAX_DEPTH) {
      warnings.push(`引用嵌套超过 ${INCLUDE_MAX_DEPTH} 层：${path}`);
      return "";
    }
    const key = process.platform === "win32" ? safe.absolute.toLowerCase() : safe.absolute;
    if (visited.has(key)) {
      warnings.push(`重复引用或环路，已跳过：${path}`);
      return "";
    }
    let content: string;
    try {
      content = readFileSync(safe.absolute, "utf8");
    } catch {
      warnings.push(`引用文件不存在或不可读：${path}`);
      return "";
    }
    visited.add(key);
    let fence: { char: string; length: number } | null = null;
    return content.split(/\r?\n/).map((line) => {
      // 关闭围栏必须与开头的字符一致且至少同样长，防止代码中的短围栏误关闭。
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
        else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
        return line;
      }
      if (fence) return line;
      const target = /^@(\S+)$/.exec(line.trim())?.[1];
      if (!target || !(/^(\.\.?\/|~\/)/.test(target) || target.includes("/") || /\.[A-Za-z0-9]+$/.test(target))) return line;
      const absolute = target.startsWith("~/") ? resolve(homeDir, target.slice(2)) : resolve(dirname(safe.absolute), target);
      return expand(absolute, root, depth + 1);
    }).join("\n");
  }

  const sections: string[] = [];
  for (const source of instructionSources(workDir, homeDir)) {
    try {
      if (!existsSync(source.path)) continue; //f返回的是label 和全部的内容
      //获取的是对应的每个memory的文件内容
      const content = expand(source.path, source.root, 0); //
      if (content.trim()) sections.push(`## ${source.label}\n${content}`);
    } catch {
      warnings.push(`指令文件不可读：${source.path}`);
    }
  }
  return {
    text: sections.length ? `# 项目指令\n多份指令冲突时，以排在前面的为准。\n\n${sections.join("\n\n")}` : "",
    warnings,
  };
}
