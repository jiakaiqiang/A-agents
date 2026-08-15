#!/usr/bin/env bun
import { closeSync, openSync, writeSync } from "node:fs";
import React from "react";
import { render } from "ink";
import cursor from "cli-cursor";
import { loadConfig } from "./config/config.js";
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
const instance = render(
  <App providers={config.providers} mcpServers={config.mcp_servers} hooks={config.hooks} />,
  { exitOnCtrlC: false },
);

await instance.waitUntilExit();
restoreCursor();
