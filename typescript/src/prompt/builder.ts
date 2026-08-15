import { arch, platform } from "node:os";
import { execSync } from "node:child_process";
import type { EnvironmentContext, Section } from "./sections.js";
import {
  doingTasksSection,
  environmentSection,
  executingActionsSection,
  identitySection,
  outputEfficiencySection,
  systemSection,
  toneStyleSection,
  usingToolsSection,
} from "./sections.js";

export interface BuildOptions {
  skills?: string;
  customInstructions?: string;
  memory?: string;
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

export function buildSystemPrompt(environment: EnvironmentContext, options: BuildOptions = {}): string {
  const builder = new PromptBuilder()
    .add(identitySection())
    .add(systemSection())
    .add(doingTasksSection())
    .add(executingActionsSection())
    .add(usingToolsSection())
    .add(toneStyleSection())
    .add(outputEfficiencySection())
    .add(environmentSection(environment));

  if (options.skills?.trim()) builder.add({ name: "Skills", priority: 90, content: options.skills });
  if (options.customInstructions?.trim()) {
    builder.add({ name: "CustomInstructions", priority: 95, content: options.customInstructions });
  }
  if (options.memory?.trim()) builder.add({ name: "Memory", priority: 100, content: options.memory });
  return builder.build();
}
