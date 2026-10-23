import { afterEach, beforeEach, expect, test } from "bun:test";
import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadInstructions } from "../../src/memory/instructions.js";
import { fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

test("三层指令按优先级拼接，缺失的来源省略", () => {
  expect(loadInstructions(f.workDir, f.homeDir)).toEqual({ text: "", warnings: [] });
  f.write(join(f.workDir, "MEWCODE.md"), "ROOT");
  f.write(join(f.workDir, ".mewcode/MEWCODE.md"), "PROJECT");
  f.write(join(f.homeDir, ".mewcode/MEWCODE.md"), "USER");
  const result = loadInstructions(f.workDir, f.homeDir);
  expect(result.warnings).toEqual([]);
  expect(result.text.indexOf("ROOT")).toBeLessThan(result.text.indexOf("PROJECT"));
  expect(result.text.indexOf("PROJECT")).toBeLessThan(result.text.indexOf("USER"));
  expect(result.text).toContain("冲突时，以排在前面的为准");
  unlinkSync(join(f.workDir, ".mewcode/MEWCODE.md"));
  expect(loadInstructions(f.workDir, f.homeDir).text).not.toContain("PROJECT");
});

test("相对引用和用户根引用展开，注解、代码围栏内引用保留", () => {
  f.write(join(f.workDir, "MEWCODE.md"), "@docs/a.md\n@Override\n@Test\n````md\n```\n@missing.md\n````\n~~~\n@missing.md\n~~~");
  f.write(join(f.workDir, "docs/a.md"), "A\n@./b.md");
  f.write(join(f.workDir, "docs/b.md"), "B");
  f.write(join(f.homeDir, ".mewcode/MEWCODE.md"), "@~/.mewcode/rules.md");
  f.write(join(f.homeDir, ".mewcode/rules.md"), "USER-RULES");
  const result = loadInstructions(f.workDir, f.homeDir);
  expect(result.warnings).toEqual([]);
  expect(result.text).toContain("A\nB");
  expect(result.text).toContain("@Override\n@Test");
  expect(result.text).toContain("@missing.md");
  expect(result.text).toContain("USER-RULES");
});

test("环路、重复、超过五层、越界和缺失都告警且不中断", () => {
  f.write(join(f.workDir, "MEWCODE.md"), "@a.md\n@a.md\n@../outside.md\n@missing.md\n@depth1.md");
  f.write(join(f.workDir, "a.md"), "A\n@MEWCODE.md");
  for (let i = 1; i <= 6; i++) f.write(join(f.workDir, `depth${i}.md`), `LEVEL${i}\n${i < 6 ? `@depth${i + 1}.md` : ""}`);
  f.write(join(f.homeDir, ".mewcode/MEWCODE.md"), "@~/outside.md");
  const result = loadInstructions(f.workDir, f.homeDir);
  expect(result.text).toContain("LEVEL5");
  expect(result.text).not.toContain("LEVEL6");
  expect(result.warnings.filter((warning) => warning.includes("重复引用或环路"))).toHaveLength(2);
  expect(result.warnings.filter((warning) => warning.includes("越界"))).toHaveLength(2);
  expect(result.warnings.some((warning) => warning.includes("超过 5 层"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("不存在"))).toBe(true);
});

test("符号链接逃逸被拦截，快照不随文件修改变化", () => {
  f.write(join(f.homeDir, "outside/rules.md"), "OUTSIDE");
  symlinkSync(join(f.homeDir, "outside"), join(f.workDir, "linked"), "junction");
  f.write(join(f.workDir, "MEWCODE.md"), "ORIGINAL\n@linked/rules.md");
  const first = loadInstructions(f.workDir, f.homeDir);
  expect(first.text).not.toContain("OUTSIDE");
  expect(first.warnings.join()).toContain("越界");
  f.write(join(f.workDir, "MEWCODE.md"), "CHANGED");
  expect(first.text).toContain("ORIGINAL");
  expect(loadInstructions(f.workDir, f.homeDir).text).toContain("CHANGED");
});
