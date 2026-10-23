import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreview,
  maybeSpillResult,
  spillToFile,
  SPILL_PREVIEW_CHARS,
  TOOL_SPILL_TOKENS,
} from "../../src/context/spill.js";
import { TokenEstimator } from "../../src/context/tokens.js";
import { ok } from "../../src/tools/types.js";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mewcode-spill-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 超过单条阈值所需的最小字符量。 */
function oversizedContent(): string {
  return "x".repeat((TOOL_SPILL_TOKENS + 100) * 4);
}

describe("spillToFile", () => {
  test("写入 .mewcode/tool-outputs 并返回 POSIX 路径", () => {
    const path = spillToFile("Bash", "hello", workDir);
    expect(path).not.toBeNull();
    expect(path!).toContain(".mewcode/tool-outputs/");
    expect(path!).toMatch(/Bash-\d{8}-\d{6}-[a-z0-9]{1,6}\.txt$/);
    expect(readFileSync(path!, "utf-8")).toBe("hello");
  });

  test("目录不可创建时返回 null，不抛错", () => {
    // 用一个已存在的文件当作 workDir，mkdir 必然失败。
    const filePath = join(workDir, "not-a-dir");
    writeFileSync(filePath, "x");
    const path = spillToFile("Bash", "hello", filePath);
    expect(path).toBeNull();
  });

  test("工具名中的路径和 Windows 非法字符不会进入文件名", () => {
    const path = spillToFile("mcp/foo:bar\\baz?", "hello", workDir);
    expect(path).not.toBeNull();
    expect(path!).toMatch(/mcp-foo-bar-baz--\d{8}-\d{6}-[a-z0-9]+\.txt$/);
    expect(readFileSync(path!, "utf8")).toBe("hello");
  });
});

describe("buildPreview", () => {
  test("预览含开头原文与存盘路径提示", () => {
    const content = "a".repeat(2000);
    const preview = buildPreview(content, "/tmp/x.txt");
    expect(preview.startsWith("a".repeat(SPILL_PREVIEW_CHARS))).toBe(true);
    expect(preview).toContain("/tmp/x.txt");
    expect(preview).toContain("2000 字符");
    expect(preview).toContain("Read");
  });
});

describe("maybeSpillResult", () => {
  test("未超阈值时原文返回，不产生文件", async () => {
    const estimator = new TokenEstimator();
    const outcome = await maybeSpillResult("Read", ok("短内容", "s"), workDir, estimator);
    expect(outcome.spilled).toBe(false);
    expect(outcome.content).toBe("短内容");
    expect(existsSync(join(workDir, ".mewcode", "tool-outputs"))).toBe(false);
  });

  test("超阈值时存盘并返回预览", async () => {
    const estimator = new TokenEstimator();
    const content = oversizedContent();
    const outcome = await maybeSpillResult("Bash", ok(content, "s"), workDir, estimator);
    expect(outcome.spilled).toBe(true);
    expect(outcome.filePath).toBeDefined();
    expect(readFileSync(outcome.filePath!, "utf-8")).toBe(content);
    expect(outcome.content.length).toBeLessThan(content.length);
    expect(outcome.content).toContain("完整输出已存盘");
  });

  test("存盘失败时回退原文，不抛错", async () => {
    const estimator = new TokenEstimator();
    const filePath = join(workDir, "blocked");
    writeFileSync(filePath, "x");
    const content = oversizedContent();
    const outcome = await maybeSpillResult("Bash", ok(content, "s"), filePath, estimator);
    expect(outcome.spilled).toBe(false);
    expect(outcome.content).toBe(content);
  });
});
