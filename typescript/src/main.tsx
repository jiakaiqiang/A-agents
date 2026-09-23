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

try {
  ttyFd = openSync(process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty", "w");
  writeSync(ttyFd, "[?25l");
  cursor.show = () => undefined;
} catch {
  ttyFd = null;
}

process.on("exit", restoreCursor);

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

const instance = render(
  <App providers={config.providers} hooks={config.hooks} registry={registry} mcpReports={mcpReports} />,
  { exitOnCtrlC: false },
);

await instance.waitUntilExit();
restoreCursor();
