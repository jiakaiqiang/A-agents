import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { platform } from "node:os";
import { redact } from "./redact.js";
import { BASH_MAX_OUTPUT_CHARS, BASH_MAX_TIMEOUT_MS, BASH_TIMEOUT_MS } from "./limits.js";
import { fail, numberArg, ok, stringArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const schema = {
  type: "object" as const,
  properties: {
    command: { type: "string" as const, description: "在工作目录中执行的 shell 命令" },
    timeout: { type: "integer" as const, description: `命令超时毫秒数，默认 ${BASH_TIMEOUT_MS}` },
    description: { type: "string" as const, description: "命令用途的简短说明" },
  },
  required: ["command"],
};

function shellFor(command: string): { executable: string; args: string[] } {
  if (platform() === "win32") {
    return { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable: "/bin/sh", args: ["-c", command] };
}

function appendLimited(current: string, chunk: Buffer, limit: number): { value: string; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const remaining = limit - current.length;
  const text = chunk.toString("utf8");
  if (text.length <= remaining) return { value: current + text, truncated: false };
  return { value: current + text.slice(0, remaining), truncated: true };
}

function abortError(): Error {
  const error = new Error("操作已中断");
  error.name = "AbortError";
  return error;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  if (platform() === "win32" && child.pid) {
    // kill() 不一定会结束 Windows 子进程树，额外 taskkill 保证超时后无残留。
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const command = stringArg(args, "command");
  const requested = numberArg(args, "timeout") ?? BASH_TIMEOUT_MS;
  const timeout = Math.max(1, Math.min(requested, BASH_MAX_TIMEOUT_MS));
  const shell = shellFor(command);

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell.executable, shell.args, {
        cwd: context.workDir,
        windowsHide: true,
        windowsVerbatimArguments: platform() === "win32",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve(fail("exec_failed", `无法启动命令：${message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = (): void => {
      terminate(child);
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeout);

    if (context.signal?.aborted) {
      onAbort();
      return;
    }
    context.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendLimited(stdout, chunk, BASH_MAX_OUTPUT_CHARS);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendLimited(stderr, chunk, BASH_MAX_OUTPUT_CHARS);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (error) => finish(fail("exec_failed", `无法启动命令：${error.message}`)));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(fail(
          "timeout",
          `命令在 ${Math.ceil(timeout / 1000)} 秒后超时`,
          { timeout, stdout, stderr, stdoutTruncated, stderrTruncated },
        ));
        return;
      }

      const exitCode = code ?? -1;
      const output = [
        `exit code: ${exitCode}`,
        `stdout:\n${stdout || "(empty)"}${stdoutTruncated ? "\n[truncated]" : ""}`,
        `stderr:\n${stderr || "(empty)"}${stderrTruncated ? "\n[truncated]" : ""}`,
      ].join("\n\n");
      // 非零退出常用于表达"无匹配"或"有差异"，因此保留为成功工具调用。
      finish(ok(output, `exit ${exitCode}`, {
        exitCode,
        signal,
        stdoutTruncated,
        stderrTruncated,
      }));
    });
  });
}

export const BashTool: Tool = {
  name: "Bash",
  description: "在当前工作目录下执行 shell 命令，返回标准输出、标准错误和退出码。",
  parameters: schema,
  callSummary: (args) => `Bash(${redact(stringArg(args, "command")).replace(/[\r\n]+/g, " ").slice(0, 72)})`,
  execute,
};
