import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decide } from "../../src/permission/decide.js";
import { parseRule } from "../../src/permission/rules.js";
import type { ConfirmChoice, PermissionGate, RuleSet } from "../../src/permission/types.js";
import { BashTool } from "../../src/tools/bash.js";
import { GlobTool } from "../../src/tools/glob.js";
import { ReadTool } from "../../src/tools/read.js";
import { WriteTool } from "../../src/tools/write.js";
import { emptyRuleSet, gateWith } from "./helpers.js";

function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), "mewcode-decide-"));
  writeFileSync(join(root, "a.ts"), "ok");
  return root;
}

function recordingGate(mode: PermissionGate["mode"], confirm?: () => Promise<ConfirmChoice>, rules: RuleSet = emptyRuleSet()) {
  const granted = { session: 0, always: 0 };
  const gate = gateWith(mode, rules, {
    confirm,
    grantSession() { granted.session += 1; },
    grantAlways() { granted.always += 1; },
  });
  return { gate, granted };
}

describe("decide", () => {
  test("黑名单在放行档且有 allow 规则时仍拒", async () => {
    const rules = emptyRuleSet();
    rules.layers.project.push(parseRule("Bash(rm *)", "allow", "project", 0)!);
    const { gate } = recordingGate("bypass", undefined, rules);
    const decision = await decide(BashTool, { command: "rm -rf /" }, { workDir: workDir(), permission: gate });
    expect(decision.verdict).toBe("deny");
    if (decision.verdict === "deny") {
      expect(decision.layer).toBe("blacklist");
      expect(decision.reason).toContain("不可通过配置");
    }
  });

  test("沙箱在放行档仍拒目录外写入", async () => {
    const { gate } = recordingGate("bypass");
    const outside = resolve(tmpdir(), "outside.txt");
    const decision = await decide(WriteTool, { file_path: outside, content: "x" }, {
      workDir: workDir(),
      permission: gate,
    });
    expect(decision.verdict).toBe("deny");
    if (decision.verdict === "deny") expect(decision.layer).toBe("sandbox");
  });

  test("黑名单短路，规则层不被求值", async () => {
    const rules = emptyRuleSet();
    Object.defineProperty(rules.layers, "project", {
      get() { throw new Error("规则层不应被求值"); },
    });
    const { gate } = recordingGate("bypass", undefined, rules);
    const decision = await decide(BashTool, { command: "rm -rf /" }, { workDir: workDir(), permission: gate });
    expect(decision.verdict).toBe("deny");
    if (decision.verdict === "deny") expect(decision.layer).toBe("blacklist");
  });

  test("deny 规则不被放行档覆盖；allow 规则在计划档不弹确认", async () => {
    const denied = emptyRuleSet();
    denied.layers.project.push(parseRule("Bash(npm test)", "deny", "project", 0)!);
    const { gate: bypass } = recordingGate("bypass", async () => "once", denied);
    const deniedDecision = await decide(BashTool, { command: "npm test" }, { workDir: workDir(), permission: bypass });
    expect(deniedDecision.verdict).toBe("deny");
    if (deniedDecision.verdict === "deny") expect(deniedDecision.layer).toBe("rule");

    const allowed = emptyRuleSet();
    allowed.layers.project.push(parseRule("Bash(npm test)", "allow", "project", 0)!);
    let asked = 0;
    const { gate: plan } = recordingGate("plan", async () => { asked += 1; return "once"; }, allowed);
    const allowedDecision = await decide(BashTool, { command: "npm test" }, { workDir: workDir(), permission: plan });
    expect(allowedDecision).toEqual({ verdict: "allow", layer: "rule" });
    expect(asked).toBe(0);
  });

  test("四档三类工具的兜底矩阵", async () => {
    const asked: string[] = [];
    const confirm = async () => { asked.push("ask"); return "once" as const; };
    const cases: Array<[PermissionGate["mode"], typeof ReadTool, "allow" | "ask"]> = [
      ["plan", ReadTool, "allow"],
      ["plan", WriteTool, "ask"],
      ["plan", BashTool, "ask"],
      ["default", ReadTool, "allow"],
      ["default", WriteTool, "ask"],
      ["default", BashTool, "ask"],
      ["acceptEdits", ReadTool, "allow"],
      ["acceptEdits", WriteTool, "allow"],
      ["acceptEdits", BashTool, "ask"],
      ["bypass", ReadTool, "allow"],
      ["bypass", WriteTool, "allow"],
      ["bypass", BashTool, "allow"],
    ];
    const dir = workDir();
    for (const [mode, tool, expected] of cases) {
      asked.length = 0;
      const { gate } = recordingGate(mode, confirm);
      const args = tool === BashTool
        ? { command: "npm test" }
        : tool === WriteTool
          ? { file_path: "a.ts", content: "x" }
          : { file_path: "a.ts" };
      const decision = await decide(tool, args, { workDir: dir, permission: gate });
      expect(decision.verdict).toBe("allow");
      if (expected === "ask") expect(asked).toEqual(["ask"]);
      else expect(asked).toEqual([]);
    }
    expect(GlobTool.readOnly).toBe(true);
  });

  test("本次放行不登记规则", async () => {
    const { gate, granted } = recordingGate("default", async () => "once");
    const decision = await decide(WriteTool, { file_path: "a.ts", content: "x" }, {
      workDir: workDir(),
      permission: gate,
    });
    expect(decision).toEqual({ verdict: "allow", layer: "human" });
    expect(granted).toEqual({ session: 0, always: 0 });
  });

  test("本会话放行调用 grantSession", async () => {
    const { gate, granted } = recordingGate("default", async () => "session");
    await decide(WriteTool, { file_path: "a.ts", content: "x" }, { workDir: workDir(), permission: gate });
    expect(granted).toEqual({ session: 1, always: 0 });
  });

  test("永久放行调用 grantAlways", async () => {
    const { gate, granted } = recordingGate("default", async () => "always");
    await decide(WriteTool, { file_path: "a.ts", content: "x" }, { workDir: workDir(), permission: gate });
    expect(granted).toEqual({ session: 0, always: 1 });
  });

  test("拒绝使用固定文案", async () => {
    const { gate } = recordingGate("default", async () => "deny");
    const decision = await decide(WriteTool, { file_path: "a.ts", content: "x" }, {
      workDir: workDir(),
      permission: gate,
    });
    expect(decision.verdict).toBe("deny");
    if (decision.verdict === "deny") {
      expect(decision.layer).toBe("human");
      expect(decision.reason).toBe("用户拒绝了此操作");
    }
  });

  test("confirm 缺失时 ask 转拒绝；无 Gate 时读类放行写类拒绝", async () => {
    const { gate } = recordingGate("default");
    const noConfirm = await decide(WriteTool, { file_path: "a.ts", content: "x" }, {
      workDir: workDir(),
      permission: gate,
    });
    expect(noConfirm.verdict).toBe("deny");
    if (noConfirm.verdict === "deny") expect(noConfirm.reason).toContain("无法交互确认");

    const dir = workDir();
    const read = await decide(ReadTool, { file_path: "a.ts" }, { workDir: dir });
    expect(read).toEqual({ verdict: "allow", layer: "mode" });
    const write = await decide(WriteTool, { file_path: "a.ts", content: "x" }, { workDir: dir });
    expect(write.verdict).toBe("deny");
  });

  test("confirm 抛异常按拒绝处理", async () => {
    const { gate } = recordingGate("default", async () => { throw new Error("boom"); });
    const decision = await decide(WriteTool, { file_path: "a.ts", content: "x" }, {
      workDir: workDir(),
      permission: gate,
    });
    expect(decision.verdict).toBe("deny");
    if (decision.verdict === "deny") expect(decision.layer).toBe("human");
  });

  test("四种拒绝原因彼此可区分", async () => {
    const dir = workDir();
    const blacklist = await decide(BashTool, { command: "rm -rf /" }, { workDir: dir });
    const sandbox = await decide(WriteTool, { file_path: resolve(tmpdir(), "x.txt"), content: "x" }, { workDir: dir });
    const rules = emptyRuleSet();
    rules.layers.project.push(parseRule("Bash(npm test)", "deny", "project", 0)!);
    const { gate } = recordingGate("bypass", async () => "deny", rules);
    const rule = await decide(BashTool, { command: "npm test" }, { workDir: dir, permission: gate });
    const { gate: humanGate } = recordingGate("default", async () => "deny");
    const human = await decide(WriteTool, { file_path: "a.ts", content: "x" }, { workDir: dir, permission: humanGate });
    const reasons = [blacklist, sandbox, rule, human].map((item) => item.verdict === "deny" ? item.reason : "");
    expect(new Set(reasons).size).toBe(4);
  });
});
