import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveInside, toPosix } from "../../src/tools/paths.js";

describe("resolveInside", () => {
  const roots: string[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "mewcode-paths-"));
    roots.push(root);
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "b.txt"), "ok");
    return root;
  }

  test("工作目录内相对路径通过并使用 POSIX 展示", () => {
    const root = makeRoot();
    const result = resolveInside(root, join("a", "b.txt"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.display).toBe("a/b.txt");
  });

  test("尚不存在的目标文件通过", () => {
    const root = makeRoot();
    const result = resolveInside(root, "a/new.txt");
    expect(result.ok).toBe(true);
  });

  test(".. 越界被拒", () => {
    const root = makeRoot();
    const result = resolveInside(root, "../outside.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("超出工作目录");
  });

  test("空路径被拒", () => {
    const root = makeRoot();
    expect(resolveInside(root, "").ok).toBe(false);
    expect(resolveInside(root, null).ok).toBe(false);
  });

  test("工作目录外绝对路径被拒", () => {
    const root = makeRoot();
    const outside = resolve(tmpdir(), "outside.txt");
    expect(resolveInside(root, outside).ok).toBe(false);
  });

  test("指向外部的符号链接被拒", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "mewcode-outside-"));
    const link = join(root, "link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return;
    }
    expect(existsSync(link)).toBe(true);
    expect(resolveInside(root, "link/secret.txt").ok).toBe(false);
  });

  test("路径转换为 POSIX 风格", () => {
    expect(toPosix("a\\b\\c.ts")).toBe("a/b/c.ts");
  });
});
