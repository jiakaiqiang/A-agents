import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkSandbox, extractPathCandidates } from "../../src/permission/sandbox.js";
import { BashTool } from "../../src/tools/bash.js";
import { GlobTool } from "../../src/tools/glob.js";
import { WriteTool } from "../../src/tools/write.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mewcode-sandbox-"));
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "b.txt"), "ok");
  return root;
}

describe("extractPathCandidates", () => {
  test("抓取绝对路径", () => {
    expect(extractPathCandidates("cat /etc/passwd")).toContain("/etc/passwd");
  });

  test("抓取含 .. 的相对路径", () => {
    expect(extractPathCandidates("cd ../other && ls")).toContain("../other");
  });

  test("抓取引号内的路径", () => {
    expect(extractPathCandidates('cat "/etc/passwd"')).toContain("/etc/passwd");
  });

  test("选项词不当路径", () => {
    expect(extractPathCandidates("rm -rf dist")).not.toContain("-rf");
  });
});

describe("checkSandbox", () => {
  test("Bash 绝对路径越界被拒", () => {
    const result = checkSandbox(BashTool, { command: "cat /etc/passwd" }, makeRoot());
    expect(result.verdict).toBe("deny");
    expect(result.reason).toContain("超出工作目录");
  });

  test("Bash .. 越界被拒", () => {
    const result = checkSandbox(BashTool, { command: "cd ../other && ls" }, makeRoot());
    expect(result.verdict).toBe("deny");
  });

  test("Bash 无路径片段不表态", () => {
    expect(checkSandbox(BashTool, { command: "npm test" }, makeRoot()).verdict).toBe("abstain");
  });

  test("Write 目录外绝对路径被拒", () => {
    const root = makeRoot();
    const outside = resolve(tmpdir(), "outside.txt");
    const result = checkSandbox(WriteTool, { file_path: outside, content: "x" }, root);
    expect(result.verdict).toBe("deny");
  });

  test("Write 目录内尚不存在的新文件不表态", () => {
    const result = checkSandbox(WriteTool, { file_path: "a/new.txt", content: "x" }, makeRoot());
    expect(result.verdict).toBe("abstain");
  });

  test("指向目录外的符号链接被拒", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "mewcode-outside-"));
    const link = join(root, "link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return;
    }
    expect(existsSync(link)).toBe(true);
    expect(checkSandbox(WriteTool, { file_path: "link/secret.txt", content: "x" }, root).verdict).toBe("deny");
  });

  test("Glob 不传 path 不表态", () => {
    expect(checkSandbox(GlobTool, { pattern: "**/*.ts" }, makeRoot()).verdict).toBe("abstain");
  });
});
