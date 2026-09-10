import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendLocalRule, loadPermissionConfig } from "../../src/permission/config.js";
import type { ConfirmChoice, PermissionGate, Rule } from "../../src/permission/types.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { runTool } from "../../src/tools/execute.js";
import { emptyRuleSet } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "mewcode-perm-e2e-"));
  roots.push(value);
  return value;
}

/** 模拟 TUI 侧的 Gate：confirm 由脚本回答，放行登记落到内存或本地文件。 */
function gate(cwd: string, mode: PermissionGate["mode"], answers: ConfirmChoice[]) {
  const rules = loadPermissionConfig(cwd).rules;
  const asked: string[] = [];
  const permission: PermissionGate = {
    mode,
    rules,
    async confirm(request) {
      asked.push(request.summary);
      return answers.shift() ?? "deny";
    },
    grantSession(rule: Rule) { rules.layers.session.push(rule); },
    grantAlways(rule: Rule) { appendLocalRule(rule, cwd); rules.layers.local.push(rule); },
  };
  return { permission, asked };
}

const registry = createDefaultRegistry();

describe("端到端：确认放行", () => {
  test("场景 1 默认档确认后文件真正写入", async () => {
    const cwd = root();
    const { permission, asked } = gate(cwd, "default", ["once"]);
    const result = await runTool(registry, "Write", { file_path: "note.txt", content: "写成功" }, {
      workDir: cwd,
      permission,
    });
    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("写成功");
  });

  test("场景 3 放行档不再询问", async () => {
    const cwd = root();
    const { permission, asked } = gate(cwd, "bypass", []);
    const result = await runTool(registry, "Write", { file_path: "a.txt", content: "x" }, {
      workDir: cwd,
      permission,
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe("端到端：硬拦截", () => {
  test("场景 2 黑名单拒绝且不终止流程", async () => {
    const cwd = root();
    const { permission } = gate(cwd, "default", []);
    const result = await runTool(registry, "Bash", { command: "rm -rf /" }, { workDir: cwd, permission });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("permission_denied");
    expect(result.content).toContain("不可通过配置");

    // 同一上下文继续调用，说明拒绝没有让后续调用失效。
    const next = await runTool(registry, "Glob", { pattern: "*.txt" }, { workDir: cwd, permission });
    expect(next.ok).toBe(true);
  });

  test("场景 4 放行档下沙箱仍拦目录外写入", async () => {
    const cwd = root();
    const { permission } = gate(cwd, "bypass", []);
    const outside = resolve(tmpdir(), "mewcode-should-not-exist.txt");
    const result = await runTool(registry, "Write", { file_path: outside, content: "x" }, {
      workDir: cwd,
      permission,
    });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("permission_denied");
    expect(existsSync(outside)).toBe(false);
  });

  test("拒绝时工具没有产生副作用", async () => {
    const cwd = root();
    const { permission } = gate(cwd, "default", ["deny"]);
    const result = await runTool(registry, "Write", { file_path: "never.txt", content: "x" }, {
      workDir: cwd,
      permission,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(cwd, "never.txt"))).toBe(false);
  });
});

describe("端到端：放行粒度", () => {
  test("场景 5 永久放行落盘且重新加载后免询问", async () => {
    const cwd = root();
    const first = gate(cwd, "default", ["always"]);
    await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission: first.permission });
    expect(first.asked).toHaveLength(1);
    expect(readFileSync(join(cwd, ".mewcode", "config.local.yaml"), "utf8")).toContain("Bash(echo hi)");

    // 重建 Gate 等价于重启进程：规则从文件重新读出。
    const second = gate(cwd, "default", []);
    const result = await runTool(registry, "Bash", { command: "echo hi" }, {
      workDir: cwd,
      permission: second.permission,
    });
    expect(result.ok).toBe(true);
    expect(second.asked).toEqual([]);
  });

  test("本会话放行不落盘，重建 Gate 后重新询问", async () => {
    const cwd = root();
    const first = gate(cwd, "default", ["session"]);
    await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission: first.permission });
    // 第二次同样调用命中会话规则，不再询问。
    await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission: first.permission });
    expect(first.asked).toHaveLength(1);
    expect(existsSync(join(cwd, ".mewcode", "config.local.yaml"))).toBe(false);

    const second = gate(cwd, "default", ["deny"]);
    await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission: second.permission });
    expect(second.asked).toHaveLength(1);
  });

  test("本次放行下次仍询问", async () => {
    const cwd = root();
    const { permission, asked } = gate(cwd, "default", ["once", "once"]);
    await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission });
    await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission });
    expect(asked).toHaveLength(2);
  });
});

describe("端到端：规则优先于档位", () => {
  test("场景 6 项目级 deny 规则在放行档下仍生效", async () => {
    const cwd = root();
    appendLocalRule({ tool: "Bash", pattern: "echo *", effect: "deny", source: "local", order: 0 }, cwd);
    const { permission } = gate(cwd, "bypass", []);
    const result = await runTool(registry, "Bash", { command: "echo hi" }, { workDir: cwd, permission });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("规则拒绝");
  });
});

describe("端到端：读类不受干扰", () => {
  test("读类工具在最严档位下也不触发确认", async () => {
    const cwd = root();
    const { permission, asked } = gate(cwd, "plan", []);
    const result = await runTool(registry, "Glob", { pattern: "*.md" }, { workDir: cwd, permission });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
  });

  test("无 Gate 时读类可用、写类被拒", async () => {
    const cwd = root();
    const read = await runTool(registry, "Glob", { pattern: "*.md" }, { workDir: cwd });
    expect(read.ok).toBe(true);
    const write = await runTool(registry, "Write", { file_path: "x.txt", content: "x" }, { workDir: cwd });
    expect(write.ok).toBe(false);
    expect(write.errorKind).toBe("permission_denied");
  });
});
