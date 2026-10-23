import { describe, expect, test } from "bun:test";
import { endpointHost, formatHelp, formatMemory, formatPermission, formatSession, formatSkills, formatStatus, MODE_TAGS } from "../../src/commands/format.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import type { CommandDef } from "../../src/commands/types.js";
import { FAKE_SNAPSHOT, FAKE_USAGE } from "./fake-ui.js";

describe("endpointHost", () => {
  test("只保留主机名与端口，丢掉 userinfo、路径与查询串", () => {
    expect(endpointHost("https://user:pass@api.example.com:8443/v1?key=SECRET")).toBe("api.example.com:8443");
  });
  test("空串与非法地址", () => {
    expect(endpointHost("")).toBe("默认端点");
    expect(endpointHost("not a url")).toBe("（地址无法解析）");
  });
});

describe("formatStatus", () => {
  test("包含状态字段且不泄露敏感配置", () => {
    const text = formatStatus(FAKE_SNAPSHOT, FAKE_USAGE);
    for (const part of ["test", "openai-compat", "模型：m", "api.example.com", "[DEFAULT]", "1000/128000", "（1%）", "MCP 0/0 已连接"]) expect(text).toContain(part);
    for (const secret of ["SECRET", "key=", "https://", "/v1"]) expect(text).not.toContain(secret);
  });
  test("估算未就绪与 MCP 计数", () => {
    const text = formatStatus(
      { ...FAKE_SNAPSHOT, mcp: [{ name: "a", status: "ok", toolCount: 1, tools: ["x"] }, { name: "b", status: "failed", reason: "r" }] },
      { ...FAKE_USAGE, usedTokens: null },
    );
    expect(text).toContain("上下文估算未就绪");
    expect(text).toContain("MCP 1/2 已连接");
  });
});

describe("formatHelp", () => {
  const registry = new CommandRegistry();
  const defs: CommandDef[] = [
    { kind: "local", name: "help", aliases: ["h"], description: "查看帮助", usage: "/help [命令名]", argHint: "[命令名]", availableWhileBusy: true, run() {} },
    { kind: "local", name: "status", aliases: [], description: "运行状态", usage: "/status", availableWhileBusy: true, run() {} },
    { kind: "local", name: "secret", aliases: [], description: "隐藏", usage: "/secret", availableWhileBusy: true, hidden: true, run() {} },
  ];
  for (const def of defs) registry.register(def);

  test("无参列出非隐藏命令并带别名", () => {
    const text = formatHelp(registry);
    expect(text).toContain("/help");
    expect(text).toContain("（别名 /h）");
    expect(text).toContain("/status");
    expect(text).not.toContain("/secret");
  });
  test("带参显示用法与参数提示，可用别名与斜杠", () => {
    for (const target of ["h", "/help"]) {
      const text = formatHelp(registry, target);
      expect(text).toContain("用法：/help [命令名]");
      expect(text).toContain("参数：[命令名]");
    }
    expect(formatHelp(registry, "status")).not.toContain("参数：");
  });
  test("未知目标", () => {
    expect(formatHelp(registry, "nope")).toBe("未知命令：/nope，输入 /help 查看可用命令");
  });
});

describe("formatMemory / formatSession / formatPermission", () => {
  test("记忆为空与分级列出", () => {
    expect(formatMemory(FAKE_SNAPSHOT)).toBe("暂无记忆");
    const text = formatMemory({ ...FAKE_SNAPSHOT, memory: { user: [{ name: "prefers-short", type: "user", description: "偏好简短" }], project: [] } });
    expect(text).toContain("用户级：");
    expect(text).toContain("prefers-short（用户偏好）— 偏好简短");
    expect(text).toContain("项目级：\n  无");
  });
  test("会话信息", () => {
    const text = formatSession(FAKE_SNAPSHOT);
    for (const part of ["20260101-000000-abcd", "消息条数：3", ".jsonl", "/resume"]) expect(text).toContain(part);
  });
  test("权限分层", () => {
    const text = formatPermission({
      ...FAKE_SNAPSHOT,
      permissionMode: "plan",
      rules: { layers: { session: [], local: [{ tool: "Bash", pattern: "git *", effect: "allow", source: "local", order: 0 }], project: [], user: [] } },
    });
    expect(text).toContain(`当前档位：${MODE_TAGS.plan}`);
    expect(text).toContain("本地规则：\n  allow Bash(git *)");
    expect(text).toContain("会话规则：\n  无");
  });
});

describe("formatSkills（Skill F12）", () => {
  test("空列表与激活标记、模式、来源", () => {
    expect(formatSkills([])).toBe("暂无可用 Skill");
    const text = formatSkills([
      { name: "commit", description: "提交改动", mode: "shared", source: "builtin", active: true },
      { name: "test", description: "跑测试", mode: "isolated", source: "project", active: false },
    ]);
    const [, commit, test] = text.split("\n");
    expect(commit).toContain("commit");
    expect(commit).toContain("共享");
    expect(commit).toContain("内部");
    expect(commit).toContain("● 已激活");
    expect(test).toContain("独立");
    expect(test).toContain("项目");
    expect(test).not.toContain("已激活");
  });
});