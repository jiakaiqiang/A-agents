#!/usr/bin/env bun
import { closeSync, openSync, writeSync } from "node:fs";
import React from "react";
import { render } from "ink";
import cursor from "cli-cursor";
import { loadConfig } from "./config/config.js";
import { McpManager, setMcpManager } from "./mcp/manager.js";
import type { McpServerReport } from "./mcp/types.js";
import { createDefaultRegistry } from "./tools/index.js";
import { App } from "./tui/app.js";
import { loadInstructions } from "./memory/instructions.js";
import { loadMemorySnapshot } from "./memory/notes.js";
import { cleanupExpiredSessions } from "./memory/session.js";
import { homedir } from "node:os";
import { createCommandsOrExit } from "./commands/builtins/index.js";
import { bootstrapSkills } from "./commands/builtins/skills.js";
import { SkillManager } from "./skills/manager.js";

let ttyFd: number | null = null;
const originalShow = cursor.show;
let restored = false;

function restoreCursor(): void {
  if (restored) return;
  restored = true;
  cursor.show = originalShow;
  if (ttyFd !== null) {
    try {
      writeSync(ttyFd, "[?25h");
      closeSync(ttyFd);
    } catch {
      // 终端不可用时无需阻断退出。
    }
    ttyFd = null;
  }
}

let config;
try {
  config = loadConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
  process.exit();
}

// 斜杠命令在进入界面前登记：撞名直接退出，不等运行时再炸（斜杠命令 spec F2、N6）。
const commands = createCommandsOrExit();

try {
  ttyFd = openSync(process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty", "w");
  writeSync(ttyFd, "[?25l");
  cursor.show = () => undefined;
} catch {
  ttyFd = null;
}

process.on("exit", restoreCursor);

// 启动快照在首个请求前固定；各模块独立降级，互不阻断。
const startup = { instructions: "", memory: "", warnings: [] as string[] };
try {
  // 加载memory 的文件内容信息
  const loaded = loadInstructions(process.cwd());
  startup.instructions = loaded.text;
  startup.warnings.push(...loaded.warnings);
} catch { startup.warnings.push("项目指令加载失败，本次使用默认指令。"); }
try { startup.memory = loadMemorySnapshot(process.cwd()); }
catch { startup.warnings.push("记忆索引加载失败，本次未注入长期记忆。"); }
cleanupExpiredSessions(process.cwd());

// MCP 工具接入（spec F4）：阻塞启动——连接完成（或全部降级）后再进聊天。
// 退出钩子里清理子进程，不留僵尸（spec N3）。
const registry = createDefaultRegistry();
const manager = new McpManager(config.mcp_servers);
setMcpManager(manager);
let mcpReports: McpServerReport[] = [];
try {
  mcpReports = await manager.connectAll(registry);
} catch (error) {
  // connectAll 内部已按 Server 降级，这里兜底总失败：不阻塞启动。
  console.error(`MCP 初始化失败：${error instanceof Error ? error.message : String(error)}`);
  await manager.disposeAll();
}
process.on("exit", () => {
  void manager.disposeAll();
});

// Skill 在 MCP 连接之后装配：白名单校验要以本次实际可用的工具为准（Skill spec F4）。
// 装配整体失败也不阻断启动，退化为没有 Skill（Skill spec N4）。
let skills: SkillManager;
let skillReport: { warnings: string[]; summary: string };
try {
  const booted = bootstrapSkills({ registry, commands, workDir: process.cwd(), homeDir: homedir() });
  skills = booted.manager;
  skillReport = { warnings: booted.warnings, summary: booted.summary };
} catch (error) {
  skills = new SkillManager([]);
  skillReport = { warnings: [`Skill 加载失败：${error instanceof Error ? error.message : String(error)}`], summary: "" };
}

const instance = render(
  <App providers={config.providers} hooks={config.hooks} registry={registry} commands={commands} skills={skills} skillReport={skillReport} mcpReports={mcpReports} contextManagement={config.context_management} startup={startup} />,
  { exitOnCtrlC: false },
);

await instance.waitUntilExit();
restoreCursor();
