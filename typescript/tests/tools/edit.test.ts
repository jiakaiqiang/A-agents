import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditTool } from "../../src/tools/edit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-edit-"));
  roots.push(value);
  return value;
}

function seed(workDir: string, content: string): string {
  const file = join(workDir, "a.txt");
  writeFileSync(file, content);
  return file;
}

describe("EditTool", () => {
  test("唯一匹配替换成功且其他内容不变", async () => {
    const workDir = root();
    const file = seed(workDir, "before\nold\nafter");
    const result = await EditTool.execute({ file_path: "a.txt", old_string: "old", new_string: "new" }, { workDir });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("before\nnew\nafter");
    expect(result.summary).toBe("replaced 1 occurrence");
  });

  test("零匹配不修改文件", async () => {
    const workDir = root();
    const file = seed(workDir, "one");
    const result = await EditTool.execute({ file_path: "a.txt", old_string: "nope", new_string: "new" }, { workDir });
    expect(result.errorKind).toBe("not_found");
    expect(readFileSync(file, "utf8")).toBe("one");
  });

  test("多匹配未开全量替换时不修改文件", async () => {
    const workDir = root();
    const file = seed(workDir, "old old old");
    const result = await EditTool.execute({ file_path: "a.txt", old_string: "old", new_string: "new" }, { workDir });
    expect(result.errorKind).toBe("match_count");
    expect(result.content).toContain("3");
    expect(readFileSync(file, "utf8")).toBe("old old old");
  });

  test("全量替换所有命中", async () => {
    const workDir = root();
    const file = seed(workDir, "old old old");
    const result = await EditTool.execute(
      { file_path: "a.txt", old_string: "old", new_string: "new", replace_all: true },
      { workDir },
    );
    expect(result.ok).toBe(true);
    expect(result.detail?.matches).toBe(3);
    expect(readFileSync(file, "utf8")).toBe("new new new");
  });

  test("特殊替换文本按字面量处理", async () => {
    const workDir = root();
    const file = seed(workDir, "old");
    await EditTool.execute({ file_path: "a.txt", old_string: "old", new_string: "$& $1" }, { workDir });
    expect(readFileSync(file, "utf8")).toBe("$& $1");
  });

  test("保留 CRLF 换行风格", async () => {
    const workDir = root();
    const file = seed(workDir, "one\r\nold\r\nthree");
    await EditTool.execute({ file_path: "a.txt", old_string: "old", new_string: "new\nline" }, { workDir });
    expect(readFileSync(file, "utf8")).toBe("one\r\nnew\r\nline\r\nthree");
  });
});
