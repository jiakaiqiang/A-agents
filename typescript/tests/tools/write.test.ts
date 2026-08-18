import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WriteTool } from "../../src/tools/write.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-write-"));
  roots.push(value);
  return value;
}

describe("WriteTool", () => {
  test("创建文件并自动创建父目录", async () => {
    const workDir = root();
    const result = await WriteTool.execute({ file_path: "nested/a.txt", content: "hello\nworld" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("created");
    expect(readFileSync(join(workDir, "nested", "a.txt"), "utf8")).toBe("hello\nworld");
  });

  test("覆盖已有文件", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.txt"), "old");
    const result = await WriteTool.execute({ file_path: "a.txt", content: "new" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("updated");
    expect(readFileSync(join(workDir, "a.txt"), "utf8")).toBe("new");
  });

  test("越界路径被拒", async () => {
    const result = await WriteTool.execute({ file_path: "../outside.txt", content: "x" }, { workDir: root() });
    expect(result.errorKind).toBe("out_of_scope");
  });

  test("向目录写入返回失败且目录未被破坏", async () => {
    const workDir = root();
    mkdirSync(join(workDir, "target"));
    const result = await WriteTool.execute({ file_path: "target", content: "x" }, { workDir });
    expect(result.errorKind).toBe("exec_failed");
    expect(existsSync(join(workDir, "target"))).toBe(true);
  });
});
