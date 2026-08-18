import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GrepTool } from "../../src/tools/grep.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-grep-"));
  roots.push(value);
  return value;
}

describe("GrepTool", () => {
  test("返回文件、行号和命中内容", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.ts"), "first\nTODO: fix\nlast");
    const result = await GrepTool.execute({ pattern: "TODO" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.ts:2:TODO: fix");
  });

  test("路径范围和文件过滤同时生效", async () => {
    const workDir = root();
    mkdirSync(join(workDir, "src"));
    mkdirSync(join(workDir, "other"));
    writeFileSync(join(workDir, "src", "a.ts"), "TODO ts");
    writeFileSync(join(workDir, "src", "a.js"), "TODO js");
    writeFileSync(join(workDir, "other", "b.ts"), "TODO other");
    const result = await GrepTool.execute({ pattern: "TODO", path: "src", glob: "**/*.ts" }, { workDir });
    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("a.js");
    expect(result.content).not.toContain("other");
  });

  test("支持忽略大小写", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.txt"), "Todo");
    const result = await GrepTool.execute({ pattern: "todo", "-i": true }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Todo");
  });

  test("非法正则返回参数错误", async () => {
    const result = await GrepTool.execute({ pattern: "[" }, { workDir: root() });
    expect(result.errorKind).toBe("invalid_params");
  });

  test("无匹配是成功空结果", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.txt"), "hello");
    const result = await GrepTool.execute({ pattern: "TODO" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("no matches");
  });

  test("三种输出模式正确", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.txt"), "TODO\nTODO");
    const files = await GrepTool.execute({ pattern: "TODO", output_mode: "files_with_matches" }, { workDir });
    const count = await GrepTool.execute({ pattern: "TODO", output_mode: "count" }, { workDir });
    expect(files.content).toBe("a.txt");
    expect(count.content).toBe("a.txt:2");
  });
});
