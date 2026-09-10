import { describe, expect, test } from "bun:test";
import { MODE_FALLBACK, PERMISSION_MODES, classifyTool, isPermissionMode, nextPermissionMode } from "../../src/permission/limits.js";
import { BashTool } from "../../src/tools/bash.js";
import { EditTool } from "../../src/tools/edit.js";
import { GlobTool } from "../../src/tools/glob.js";
import { GrepTool } from "../../src/tools/grep.js";
import { ReadTool } from "../../src/tools/read.js";
import { WriteTool } from "../../src/tools/write.js";

describe("nextPermissionMode", () => {
  test("按计划 → 默认 → acceptEdits → 放行的顺序循环", () => {
    expect(nextPermissionMode("plan")).toBe("default");
    expect(nextPermissionMode("default")).toBe("acceptEdits");
    expect(nextPermissionMode("acceptEdits")).toBe("bypass");
  });

  test("末档绕回第一档", () => {
    expect(nextPermissionMode("bypass")).toBe("plan");
  });

  test("连按四次回到原档", () => {
    let mode = PERMISSION_MODES[0]!;
    for (let i = 0; i < PERMISSION_MODES.length; i += 1) mode = nextPermissionMode(mode);
    expect(mode).toBe(PERMISSION_MODES[0]);
  });

  test("循环覆盖全部四档，不漏不重", () => {
    const seen = new Set<string>();
    let mode = PERMISSION_MODES[0]!;
    for (let i = 0; i < PERMISSION_MODES.length; i += 1) {
      seen.add(mode);
      mode = nextPermissionMode(mode);
    }
    expect(seen.size).toBe(PERMISSION_MODES.length);
    expect([...seen].sort()).toEqual([...PERMISSION_MODES].sort());
  });
});

describe("classifyTool", () => {
  test("只读工具归 read", () => {
    for (const tool of [ReadTool, GlobTool, GrepTool]) {
      expect(classifyTool(tool)).toBe("read");
    }
  });

  test("Bash 单列，改文件的归 write", () => {
    expect(classifyTool(BashTool)).toBe("bash");
    expect(classifyTool(WriteTool)).toBe("write");
    expect(classifyTool(EditTool)).toBe("write");
  });
});

describe("MODE_FALLBACK", () => {
  test("读类在四档下一律放行", () => {
    for (const mode of PERMISSION_MODES) {
      expect(MODE_FALLBACK[mode].read).toBe("allow");
    }
  });

  test("兜底只有 allow 与 ask 两种取值", () => {
    const values = PERMISSION_MODES.flatMap((mode) => Object.values(MODE_FALLBACK[mode]));
    expect([...new Set(values)].sort()).toEqual(["allow", "ask"]);
  });
});

describe("isPermissionMode", () => {
  test("四档全部认得", () => {
    for (const mode of PERMISSION_MODES) expect(isPermissionMode(mode)).toBe(true);
  });

  test("已废弃的档位名与非字符串都不认", () => {
    expect(isPermissionMode("strict")).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
    expect(isPermissionMode(1)).toBe(false);
  });
});
