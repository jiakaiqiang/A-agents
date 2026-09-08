import type { AgentMode } from "../agent/events.js";

export interface EnvironmentContext {
  workDir: string;
  os: string;
  arch: string;
  shell: string;
  isGitRepo: boolean;
  gitBranch: string;
  model: string;
  date: string;
}

export interface Section {
  name: string;
  priority: number;
  content: string;
}

export const identitySection = (): Section => ({
  name: "Identity",
  priority: 0,
  content: "# 身份\n你是 MewCode，一个在终端中协助用户完成编程任务的 AI 助手。",
});

export const systemSection = (): Section => ({
  name: "System",
  priority: 10,
  content: "# 系统约束\n遵循用户请求，优先给出准确、可执行且与当前项目相关的回答。",
});

export const doingTasksSection = (): Section => ({
  name: "DoingTasks",
  priority: 20,
  content: "# 任务执行\n先理解上下文，再以最小必要范围完成任务；不确定时说明假设。",
});

export const executingActionsSection = (): Section => ({
  name: "ExecutingActions",
  priority: 30,
  content: "# 执行动作\n涉及不可逆或对外操作前，请向用户确认。",
});

export interface ToolSummary {
  name: string;
  description: string;
}

export const usingToolsSection = (tools: ToolSummary[] = [], mode: AgentMode = "execute"): Section => {
  if (tools.length === 0) {
    return {
      name: "UsingTools",
      priority: 40,
      content: "# 工具使用\n本次会话尚未配置工具调用能力，请直接以文本形式协助用户。",
    };
  }

  const list = tools.map((tool) => `- ${tool.name}：${tool.description}`).join("\n");
  const lines = [
    "# 工具使用",
    "可用工具：",
    list,
    "约束：",
    "- 可以在一轮内连续调用多个工具，根据每次结果决定下一步，直到任务完成。",
    "- 文件路径使用相对于工作目录的相对路径，不要访问工作目录之外的位置。",
    "- 修改文件前先用 Read 确认当前内容，避免替换失败。",
  ];

  if (mode === "plan") {
    lines.push(
      "",
      "# 计划模式",
      "当前处于计划模式，只有读类工具可用：",
      "- 只能读取和检索信息，不要尝试修改文件或执行命令。",
      "- 先把需要了解的信息读全，然后产出一份可执行的计划文本。",
      "- 用户切换到执行模式后才动手改动。",
    );
  }

  return { name: "UsingTools", priority: 40, content: lines.join("\n") };
};

export const toneStyleSection = (): Section => ({
  name: "ToneStyle",
  priority: 50,
  content: "# 表达风格\n使用中文回答，保持清晰、直接、友好。",
});

export const outputEfficiencySection = (): Section => ({
  name: "OutputEfficiency",
  priority: 60,
  content: "# 输出效率\n只提供解决当前问题所需的内容，避免无关扩展。",
});

export const environmentSection = (environment: EnvironmentContext): Section => ({
  name: "Environment",
  priority: 70,
  content: `# 运行环境\n- 工作目录：${environment.workDir}\n- 操作系统：${environment.os} (${environment.arch})\n- Shell：${environment.shell}\n- Git 仓库：${environment.isGitRepo ? `是（分支：${environment.gitBranch}）` : "否"}\n- 当前模型：${environment.model}\n- 日期：${environment.date}`,
});
