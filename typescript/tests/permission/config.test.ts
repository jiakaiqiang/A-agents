import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLocalRule, loadPermissionConfig } from "../../src/permission/config.js";
import type { Rule } from "../../src/permission/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-perm-config-"));
  roots.push(value);
  return value;
}

function writeConfig(cwd: string, name: string, content: string): void {
  mkdirSync(join(cwd, ".mewcode"), { recursive: true });
  writeFileSync(join(cwd, ".mewcode", name), content, "utf8");
}

describe("loadPermissionConfig", () => {
  test("读取项目级有序规则", () => {
    const cwd = root();
    writeConfig(cwd, "config.yaml", [
      "permissions:",
      "  - deny: Bash(git push*)",
      "  - allow: Bash(git *)",
      "",
    ].join("\n"));
    const loaded = loadPermissionConfig(cwd);
    expect(loaded.rules.layers.project.map((rule) => ({ effect: rule.effect, pattern: rule.pattern, order: rule.order }))).toEqual([
      { effect: "deny", pattern: "git push*", order: 0 },
      { effect: "allow", pattern: "git *", order: 1 },
    ]);
  });

  test("读取 permission_mode", () => {
    const cwd = root();
    writeConfig(cwd, "config.yaml", "permission_mode: acceptEdits\n");
    expect(loadPermissionConfig(cwd).mode).toBe("acceptEdits");
  });

  test("非法档位退默认并警告", () => {
    const cwd = root();
    writeConfig(cwd, "config.yaml", "permission_mode: strict\n");
    const loaded = loadPermissionConfig(cwd);
    expect(loaded.mode).toBe("default");
    expect(loaded.warnings.some((item) => item.includes("strict"))).toBe(true);
  });

  test("未声明档位时为默认档", () => {
    const cwd = root();
    writeConfig(cwd, "config.yaml", "providers: []\n");
    expect(loadPermissionConfig(cwd).mode).toBe("default");
  });

  test("YAML 语法错误产出警告且不抛异常", () => {
    const cwd = root();
    writeConfig(cwd, "config.yaml", ": : :\n  - [");
    const loaded = loadPermissionConfig(cwd);
    expect(loaded.mode).toBe("default");
    expect(loaded.rules.layers.project).toEqual([]);
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  test("非法规则项跳过并警告，其余项仍生效", () => {
    const cwd = root();
    writeConfig(cwd, "config.yaml", [
      "permissions:",
      "  - allow: Bash",
      "  - allow: Bash(git status)",
      "",
    ].join("\n"));
    const loaded = loadPermissionConfig(cwd);
    expect(loaded.warnings.length).toBeGreaterThan(0);
    expect(loaded.rules.layers.project).toHaveLength(1);
    expect(loaded.rules.layers.project[0]?.pattern).toBe("git status");
  });
});

describe("appendLocalRule", () => {
  test("写入后能被重新加载", () => {
    const cwd = root();
    const rule: Rule = { tool: "Bash", pattern: "npm test", effect: "allow", source: "local", order: 0 };
    appendLocalRule(rule, cwd);
    const loaded = loadPermissionConfig(cwd);
    expect(loaded.rules.layers.local).toHaveLength(1);
    expect(loaded.rules.layers.local[0]?.pattern).toBe("npm test");
    expect(readFileSync(join(cwd, ".mewcode", "config.local.yaml"), "utf8")).toContain("Bash(npm test)");
  });

  test("目录不存在时能创建并写入", () => {
    const cwd = root();
    appendLocalRule({ tool: "Write", pattern: "a.ts", effect: "allow", source: "local", order: 0 }, cwd);
    expect(loadPermissionConfig(cwd).rules.layers.local).toHaveLength(1);
  });

  test("两次追加后第二条 order 更大", () => {
    const cwd = root();
    appendLocalRule({ tool: "Bash", pattern: "npm test", effect: "allow", source: "local", order: 0 }, cwd);
    appendLocalRule({ tool: "Bash", pattern: "npm run build", effect: "allow", source: "local", order: 0 }, cwd);
    const loaded = loadPermissionConfig(cwd);
    expect(loaded.rules.layers.local[0]?.order).toBe(0);
    expect(loaded.rules.layers.local[1]?.order).toBe(1);
  });
});
