import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GlobTool } from "../../src/tools/glob.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-glob-"));
  roots.push(value);
  return value;
}

describe("GlobTool", () => {
  test("返回相对路径并按修改时间倒序", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "old.ts"), "old");
    writeFileSync(join(workDir, "new.ts"), "new");
    utimesSync(join(workDir, "old.ts"), new Date(1_000), new Date(1_000));
    utimesSync(join(workDir, "new.ts"), new Date(2_000), new Date(2_000));
    const result = await GlobTool.execute({ pattern: "**/*.ts" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.content.split("\n")).toEqual(["new.ts", "old.ts"]);
  });

  test("忽略版本控制、依赖与构建目录", async () => {
    const workDir = root();
    for (const dir of [".git", "node_modules", "dist"]) {
      mkdirSync(join(workDir, dir));
      writeFileSync(join(workDir, dir, "hidden.ts"), "hidden");
    }
    writeFileSync(join(workDir, "visible.ts"), "visible");
    const result = await GlobTool.execute({ pattern: "**/*.ts" }, { workDir });
    expect(result.content).toContain("visible.ts");
    expect(result.content).not.toContain("hidden.ts");
  });

  test("支持搜索根目录", async () => {
    const workDir = root();
    mkdirSync(join(workDir, "src"));
    mkdirSync(join(workDir, "other"));
    writeFileSync(join(workDir, "src", "a.ts"), "a");
    writeFileSync(join(workDir, "other", "b.ts"), "b");
    const result = await GlobTool.execute({ pattern: "**/*.ts", path: "src" }, { workDir });
    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("other/b.ts");
  });

  test("无匹配是成功空结果", async () => {
    const result = await GlobTool.execute({ pattern: "**/*.ts" }, { workDir: root() });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("no files matched");
  });

  test("越界搜索根目录被拒", async () => {
    const result = await GlobTool.execute({ pattern: "**/*", path: ".." }, { workDir: root() });
    expect(result.errorKind).toBe("out_of_scope");
  });
});
