import { arch, platform } from "node:os";
import { execSync } from "node:child_process";
import { PROMPT_PRIORITY } from "../tools/limits.js";
import type { EnvironmentContext, Section, ToolSummary } from "./sections.js";
import {
  behaviorSection,
  codeStyleSection,
  environmentSection,
  identitySection,
  outputStyleSection,
  safetySection,
  taskModeSection,
  usingToolsSection,
} from "./sections.js";

export interface BuildOptions {
  skills?: string;
  customInstructions?: string;
  memory?: string;
  /** 始终传全量工具，不随模式过滤，否则切模式会让稳定段的字节发生变化。 */
  tools?: ToolSummary[];
}

/** 系统提示词的两个缓存单元：稳定段整个会话不变，环境段按天、按模型变化。 */
export interface SystemPromptSegments {
  stable: string;
  environment: string;
}

export class PromptBuilder {
  private readonly sections: Section[] = [];

  add(section: Section): this {
    this.sections.push(section);
    return this;
  }

  build(): string {
    return [...this.sections]
      .sort((left, right) => left.priority - right.priority)
      .map((section) => section.content.trim())
      .filter(Boolean)
      .join("\n\n");
  }
}

function command(workDir: string, input: string): string {
  return execSync(input, { cwd: workDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function detectEnvironment(workDir: string, model = ""): EnvironmentContext {
  let isGitRepo = false;
  let gitBranch = "";
  try {
    isGitRepo = command(workDir, "git rev-parse --is-inside-work-tree") === "true";
    if (isGitRepo) gitBranch = command(workDir, "git rev-parse --abbrev-ref HEAD");
  } catch {
    // 当前目录不是 Git 仓库时不影响对话启动。
  }

  return {
    workDir,
    os: platform(),
    arch: arch(),
    shell: process.env.SHELL ?? process.env.ComSpec ?? "bash",
    isGitRepo,
    gitBranch,
    model,
    date: new Date().toISOString().split("T")[0],
  };
}

export function buildSystemPrompt(
  environment: EnvironmentContext,
  options: BuildOptions = {},
): SystemPromptSegments {
  const stable = new PromptBuilder()
    .add(identitySection())
    .add(safetySection())
    .add(taskModeSection())
    .add(behaviorSection())
    .add(codeStyleSection())
    .add(usingToolsSection(options.tools ?? []))
    .add(outputStyleSection());

  if (options.customInstructions?.trim()) {
    stable.add({
      name: "CustomInstructions",
      priority: PROMPT_PRIORITY.customInstructions,
      content: options.customInstructions,
    });
  }
  if (options.skills?.trim()) {
    stable.add({ name: "Skills", priority: PROMPT_PRIORITY.skills, content: options.skills });
  }
  if (options.memory?.trim()) {
    stable.add({ name: "Memory", priority: PROMPT_PRIORITY.memory, content: options.memory });
  }

  // 环境信息单独成段：它按天、按模型变化，混进稳定段会让整个前缀每天失效一次。
  return {
    stable: stable.build(),
    environment: new PromptBuilder().add(environmentSection(environment)).build(),
  };
}
