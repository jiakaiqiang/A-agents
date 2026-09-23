// 五层判定集成用例（MCP 工具视角）：档位确认、规则放行/拦截、永久放行落盘、出参截断
// （spec F11–F13、F15、AC10–AC12、AC14）。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createDefaultRegistry, runTool } from "../../src/tools/index.js";
import { McpManager } from "../../src/mcp/manager.js";
import type { McpServerConfig } from "../../src/mcp/types.js";
import type { ConfirmChoice, ConfirmRequest, PermissionGate, Rule, RuleSet } from "../../src/permission/types.js";
import { emptyRuleSet } from "../permission/helpers.js";

const MCP_SERVER = join(import.meta.dir, "fixtures", "mcp-server.ts");

function gateWith(options: {
  mode: PermissionGate["mode"];
  rules?: RuleSet;
  confirm?(request: ConfirmRequest): Promise<ConfirmChoice>;
}): PermissionGate {
  return {
    mode: options.mode,
    rules: options.rules ?? emptyRuleSet(),
    ...(options.confirm ? { confirm: options.confirm } : {}),
    grantSession() {},
    grantAlways() {},
  };
}

function rule(effect: "allow" | "deny", tool: string, pattern: string): Rule {
  return { tool, pattern, effect, source: "project", order: 0 };
}

async function connectFixture(): Promise<{ manager: McpManager; registry: ReturnType<typeof createDefaultRegistry> }> {
  const manager = new McpManager({
    fx: { type: "stdio", enabled: true, command: process.execPath, args: [MCP_SERVER], timeout: 15_000 } satisfies McpServerConfig,
  });
  const registry = createDefaultRegistry();
  const reports = await manager.connectAll(registry);
  if (reports[0]?.status !== "ok") throw new Error(`fixture 连接失败：${JSON.stringify(reports)}`);
  return { manager, registry };
}

describe("MCP 工具的五层判定集成", () => {
  test("默认档无 confirm 回调 → 拒绝且文案可辨（AC10 前提）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: gateWith({ mode: "default" }) });
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("permission_denied");
    } finally {
      await manager.disposeAll();
    }
  });

  test("默认档带 confirm → 兑付 once 后放行执行（AC10）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      const requests: ConfirmRequest[] = [];
      const gate = gateWith({
        mode: "default",
        confirm: async (request) => {
          requests.push(request);
          return "once";
        },
      });
      const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: gate });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("echo:hi");
      expect(requests).toHaveLength(1);
      // 确认请求展示来源 Server（spec F13）
      expect(requests[0]?.summary).toContain("fx.echo");
    } finally {
      await manager.disposeAll();
    }
  });

  test("allow 规则命中 → 直接放行不询问（AC10 后半）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      const rules = emptyRuleSet();
      rules.layers.project = [rule("allow", "echo", "*")];
      let asked = 0;
      const gate = gateWith({
        mode: "default",
        rules,
        confirm: async () => {
          asked += 1;
          return "deny";
        },
      });
      const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: gate });
      expect(result.ok).toBe(true);
      expect(asked).toBe(0);
    } finally {
      await manager.disposeAll();
    }
  });

  test("deny 规则在 bypass 档下仍拒绝（AC11）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      const rules = emptyRuleSet();
      rules.layers.project = [rule("deny", "echo", "*")];
      const gate = gateWith({ mode: "bypass", rules });
      const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: gate });
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("permission_denied");
      expect(result.content).toContain("规则拒绝");
    } finally {
      await manager.disposeAll();
    }
  });

  test("ruleCandidate 为可回读命中的规则文本（AC12）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      let candidate = "";
      const gate = gateWith({
        mode: "default",
        confirm: async (request) => {
          candidate = request.ruleCandidate;
          return "deny";
        },
      });
      await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: gate });
      // 无冲突注册名是原名（spec F7/F8）；候选文本以注册名开头、含参数 JSON 整串（spec F13 按 F12 语法）
      expect(candidate.startsWith("echo(")).toBe(true);
      expect(candidate).toContain(JSON.stringify({ text: "hi" }));
    } finally {
      await manager.disposeAll();
    }
  });

  test("超长出参经 runTool 截断且带标记（AC14）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      const gate = gateWith({ mode: "bypass" });
      const result = await runTool(registry, "echo", { text: "__long__" }, { workDir: process.cwd(), permission: gate });
      expect(result.ok).toBe(true);
      expect(result.content.length).toBeLessThan(100_000);
      expect(result.content).toContain("[truncated");
    } finally {
      await manager.disposeAll();
    }
  });

  test("多 text 块与占位符经 runTool 回灌（AC13 前半）", async () => {
    const { manager, registry } = await connectFixture();
    try {
      const gate = gateWith({ mode: "bypass" });
      const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: gate });
      expect(result.ok).toBe(true);
      // fixture 返回三块：text、image、text → echo:hi + 占位 + tail
      expect(result.content).toContain("echo:hi");
      expect(result.content).toContain("[非文本内容块: image]");
      expect(result.content).toContain("tail");
    } finally {
      await manager.disposeAll();
    }
  });
});
