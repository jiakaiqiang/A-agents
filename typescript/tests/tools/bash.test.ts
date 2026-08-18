import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BashTool } from "../../src/tools/bash.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-bash-"));
  roots.push(value);
  return value;
}

function command(success: string, failure: string): { success: string; failure: string; slow: string; large: string } {
  if (process.platform === "win32") {
    return {
      success: "echo hello",
      failure: "cmd /c exit 3",
      slow: "ping 127.0.0.1 -n 4 > nul",
      large: "for /L %i in (1,1,20000) do @echo 1234567890",
    };
  }
  return {
    success: "printf hello",
    failure: "exit 3",
    slow: "sleep 2",
    large: "yes 1234567890 | head -n 20000",
  };
}

describe("BashTool", () => {
  test("正常命令返回 stdout 和退出码 0", async () => {
    const commands = command("", "");
    const result = await BashTool.execute({ command: commands.success }, { workDir: root() });
    expect(result.ok).toBe(true);
    expect(result.detail?.exitCode).toBe(0);
    expect(result.content).toContain("hello");
  });

  test("非零退出不自动判为工具错误", async () => {
    const commands = command("", "");
    const result = await BashTool.execute({ command: commands.failure }, { workDir: root() });
    expect(result.ok).toBe(true);
    expect(result.detail?.exitCode).toBe(3);
  });

  test("命令超时返回 timeout", async () => {
    const commands = command("", "");
    const result = await BashTool.execute({ command: commands.slow, timeout: 100 }, { workDir: root() });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("timeout");
  });

  test("大量输出会被截断", async () => {
    const commands = command("", "");
    const result = await BashTool.execute({ command: commands.large }, { workDir: root() });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[truncated]");
  }, 20_000);

  test("工具行中的内联密钥被脱敏", () => {
    const summary = BashTool.callSummary({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuv'" });
    expect(summary).toContain("[redacted]");
    expect(summary).not.toContain("abcdefghijklmnopqrstuv");
  });
});
