// stdio 传输（plan 模块 C）：spawn 子进程，stdout 按行分帧喂协议层，
// stdin 写出请求。子进程退出即连接断开。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { platform } from "node:os";
import type { McpTransport } from "./types.js";

const STDERR_KEEP_CHARS = 500;

/**
 * Windows 上 npx 等 .cmd 包装器不经 shell 直接 spawn 时行为不稳定
 * （依赖调用环境，真 TTY 下可能启动即 stdin 断开），用 shell: true 让系统
 * 自行解析 .cmd；shell 模式下参数含空格需整体加引号。其他平台不套 shell。
 */
function spawnOptions(command: string, env: Record<string, string> | undefined): {
  command: string;
  args: string[];
  shell: boolean;
} {
  if (platform() === "win32" && (/\.(cmd|bat)$/i.test(command) || command === "npx" || command === "npm")) {
    return { command, args: [], shell: true };
  }
  return { command, args: [], shell: false };
}

/** 与 src/tools/bash.ts 的 terminate 同策略：Windows 下 kill 不保证进程树，用 taskkill 兜底。 */
function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  if (platform() === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}

export class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private messageCallback: ((text: string) => void) | null = null;
  private closeCallback: ((reason: string) => void) | null = null;
  private lineBuffer = "";
  private stderrTail = "";
  private closedByUs = false;
  private closeRequested = false;

  constructor(command: string, args: string[], env: Record<string, string> | undefined) {
    const options = spawnOptions(command, env);
    this.child = spawn(options.command, [...options.args, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: options.shell,
      env: { ...process.env, ...env },
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_KEEP_CHARS);
    });
    this.child.on("error", (error: Error) => this.emitClose(`子进程启动失败：${error.message}`));
    this.child.on("exit", (code, signal) => {
      if (this.closedByUs) return;
      const detail = signal !== null ? `信号 ${signal}` : `退出码 ${code}`;
      const stderr = this.stderrTail.trim();
      this.emitClose(`子进程退出（${detail}）${stderr ? `：${stderr}` : ""}`);
    });
  }

  private consumeStdout(chunk: Buffer): void {
    this.lineBuffer += chunk.toString("utf8");
    let index = this.lineBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this.lineBuffer.slice(0, index).trim();
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (line) this.messageCallback?.(line);
      index = this.lineBuffer.indexOf("\n");
    }
  }

  private emitClose(reason: string): void {
    this.closeCallback?.(reason);
  }

  async send(text: string): Promise<void> {
    if (this.child.stdin.destroyed || this.child.exitCode !== null) {
      throw new Error("子进程 stdin 已关闭，无法发送");
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(callback: (text: string) => void): void {
    this.messageCallback = callback;
  }

  onClose(callback: (reason: string) => void): void {
    this.closeCallback = callback;
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.child.stdin.destroy();
    terminate(this.child);
  }

  /** 子进程 pid，供测试做存活探测。 */
  get pid(): number | undefined {
    return this.child.pid;
  }
}
