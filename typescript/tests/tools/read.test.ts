import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReadTool } from "../../src/tools/read.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-read-"));
  roots.push(value);
  return value;
}

describe("ReadTool", () => {
  test("返回带真实行号的文本", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.txt"), "one\ntwo\nthree");
    const result = await ReadTool.execute({ file_path: "a.txt" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("1\tone");
    expect(result.content).toContain("3\tthree");
  });

  test("支持 offset 和 limit", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.txt"), "1\n2\n3\n4\n5");
    const result = await ReadTool.execute({ file_path: "a.txt", offset: 2, limit: 2 }, { workDir });
    expect(result.content).toContain("3\t3");
    expect(result.content).toContain("4\t4");
    expect(result.content).not.toContain("2\t2");
    expect(result.content).not.toContain("5\t5");
  });

  test("不存在文件返回 not_found", async () => {
    const result = await ReadTool.execute({ file_path: "missing.txt" }, { workDir: root() });
    expect(result.errorKind).toBe("not_found");
  });

  test("目录返回 not_found", async () => {
    const workDir = root();
    mkdirSync(join(workDir, "dir"));
    const result = await ReadTool.execute({ file_path: "dir" }, { workDir });
    expect(result.errorKind).toBe("not_found");
  });

  test("二进制文件返回 exec_failed", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "a.bin"), Buffer.from([1, 0, 2]));
    const result = await ReadTool.execute({ file_path: "a.bin" }, { workDir });
    expect(result.errorKind).toBe("exec_failed");
  });

  test("超过默认行数时标记截断", async () => {
    const workDir = root();
    writeFileSync(join(workDir, "many.txt"), Array.from({ length: 2005 }, (_, i) => String(i)).join("\n"));
    const result = await ReadTool.execute({ file_path: "many.txt" }, { workDir });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("total 2005 lines");
  });
});
