// 延迟工具加载验收用例（docs/specs/lazy-tools.md LA1–LA8）。
// 覆盖：注册期分流、toolSearch 三分支、发现后进入工具列表、
// 安全网直通/拦截、目录 reminder 文本、懒池生命周期。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { lazyCatalogReminder } from "../../src/prompt/reminder.js";
import { McpManager } from "../../src/mcp/manager.js";
import { createDefaultRegistry, runTool } from "../../src/tools/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ok, type Tool } from "../../src/tools/types.js";
import { bypassGate } from "../permission/helpers.js";
import type { McpServerConfig } from "../../src/mcp/types.js";

const MCP_SERVER = join(import.meta.dir, "fixtures", "mcp-server.ts");

function stdioFixture(name: string, extra: Partial<McpServerConfig> = {}): Record<string, McpServerConfig> {
  return { [name]: { type: "stdio", enabled: true, command: process.execPath, args: [MCP_SERVER], timeout: 15_000, ...extra } };
}

/** 造假延迟工具：loader 可控执行计数，产出确定的 Tool。 */
function fakeLazyTool(name: string, description = `${name} 的桩描述`): { entry: { name: string; description: string; loader: () => Promise<Tool> }; loads: { count: number } } {
  const loads = { count: 0 };
  const entry = {
    name,
    description,
    loader: async (): Promise<Tool> => {
      loads.count += 1;
      return {
        name,
        description: `[MCP: fx] ${description}`,
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "文本参数" } },
          required: ["text"],
        },
        readOnly: false,
        callSummary: () => `Mcp(fx.${name})`,
        async execute(args) {
          return ok(`echo:${String(args.text ?? "")}`, `echo:${String(args.text ?? "")}`);
        },
      };
    },
  };
  return { entry, loads };
}

describe("LazyToolIndex / registry（LA1、LA5）", () => {
  test("registerLazy 登记后不出现在 definitionsFor，discover 后出现（LA5）", async () => {
    const registry = createDefaultRegistry();
    const { entry } = fakeLazyTool("mcp_query_db");
    registry.registerLazy(entry);

    const before = registry.definitionsFor("openai") as Array<{ name: string }>;
    expect(before.map((item) => item.name)).not.toContain("mcp_query_db");

    const tool = await registry.discover("mcp_query_db");
    expect(tool?.name).toBe("mcp_query_db");
    expect(registry.lazySize).toBe(0);

    const after = registry.definitionsFor("openai") as Array<{ name: string }>;
    expect(after.map((item) => item.name)).toContain("mcp_query_db");
  });

  test("registerLazy 与已注册工具重名抛错；重复登记抛错", () => {
    const registry = createDefaultRegistry();
    const { entry } = fakeLazyTool("Read");
    expect(() => registry.registerLazy(entry)).toThrow();
    const first = fakeLazyTool("mcp_a");
    registry.registerLazy(first.entry);
    const second = fakeLazyTool("mcp_a");
    expect(() => registry.registerLazy(second.entry)).toThrow();
  });

  test("discover 未登记名返回 undefined；loader 抛错时懒池条目保留（LN5）", async () => {
    const registry = new ToolRegistry();
    expect(await registry.discover("nope")).toBeUndefined();

    const broken = {
      name: "mcp_broken",
      description: "坏 loader",
      loader: async (): Promise<Tool> => {
        throw new Error("loader 崩了");
      },
    };
    registry.registerLazy(broken);
    await expect(registry.discover("mcp_broken")).rejects.toThrow("loader 崩了");
    expect(registry.getLazy("mcp_broken")).toBeDefined();
    expect(registry.get("mcp_broken")).toBeUndefined();
  });
});

describe("toolSearch（LA2–LA4）", () => {
  test("精确命中懒池 → 发现并返回完整定义（LA2）", async () => {
    const registry = createDefaultRegistry();
    const { entry, loads } = fakeLazyTool("mcp_search_web");
    registry.registerLazy(entry);
    const search = registry.get("toolSearch")!;

    const result = await search.execute({ query: "mcp_search_web" }, { workDir: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("mcp_search_web");
    expect(result.content).toContain("text");
    expect(result.content).toContain("已加载");
    expect(loads.count).toBe(1);
    expect(registry.get("mcp_search_web")).toBeDefined();
    expect(registry.lazySize).toBe(0);
  });

  test("已注册工具 → 返回定义且不重复发现（LA3）", async () => {
    const registry = createDefaultRegistry();
    const { loads } = fakeLazyTool("Read");
    // Read 已在 registry，不登记懒池；toolSearch 应走 a 分支
    const search = registry.get("toolSearch")!;
    const result = await search.execute({ query: "Read" }, { workDir: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已加载");
    expect(loads.count).toBe(0);
  });

  test("未命中 → 候选列表，懒池不变（LA4）", async () => {
    const registry = createDefaultRegistry();
    const { entry } = fakeLazyTool("mcp_query_db");
    registry.registerLazy(entry);
    const search = registry.get("toolSearch")!;

    const result = await search.execute({ query: "query" }, { workDir: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("mcp_query_db");
    expect(registry.lazySize).toBe(1);
    expect(registry.get("mcp_query_db")).toBeUndefined();

    const none = await search.execute({ query: "zzz_no_match" }, { workDir: process.cwd() });
    expect(none.ok).toBe(true);
    expect(none.content).toContain("未找到");
  });

  test("空 query 与 loader 失败的降级路径", async () => {
    const registry = createDefaultRegistry();
    const search = registry.get("toolSearch")!;
    const empty = await search.execute({ query: "" }, { workDir: process.cwd() });
    expect(empty.ok).toBe(true);
    expect(empty.content).toContain("不能为空");

    const broken = {
      name: "mcp_broken",
      description: "坏 loader",
      loader: async (): Promise<Tool> => {
        throw new Error("连不上");
      },
    };
    registry.registerLazy(broken);
    const failed = await search.execute({ query: "mcp_broken" }, { workDir: process.cwd() });
    expect(failed.ok).toBe(true);
    expect(failed.content).toContain("连不上");
    expect(registry.getLazy("mcp_broken")).toBeDefined();
  });
});

describe("安全网（LA6、LA7）", () => {
  test("直接调用懒池工具且参数合法 → 发现+执行一次完成（LA6）", async () => {
    const registry = createDefaultRegistry();
    const { entry, loads } = fakeLazyTool("mcp_search_web");
    registry.registerLazy(entry);

    const result = await runTool(registry, "mcp_search_web", { text: "hi" }, { workDir: process.cwd(), permission: bypassGate() });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("echo:hi");
    expect(loads.count).toBe(1);
    expect(registry.get("mcp_search_web")).toBeDefined();
    expect(registry.lazySize).toBe(0);
  });

  test("参数不合法 → invalid_params 附 schema，工具已被发现（LA7）", async () => {
    const registry = createDefaultRegistry();
    const { entry } = fakeLazyTool("mcp_query_db");
    registry.registerLazy(entry);

    const result = await runTool(registry, "mcp_query_db", {}, { workDir: process.cwd(), permission: bypassGate() });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_params");
    expect(result.content).toContain("text");
    expect(result.content).toContain("重发");
    // 工具已被发现（registry 命中），只是本次调用参数不符
    expect(registry.get("mcp_query_db")).toBeDefined();
    expect(registry.lazySize).toBe(0);
  });

  test("懒池与 registry 均未命中 → 维持 unknown_tool（LF5c）", async () => {
    const registry = createDefaultRegistry();
    const result = await runTool(registry, "definitely_missing", {}, { workDir: process.cwd() });
    expect(result.errorKind).toBe("unknown_tool");
  });
});

describe("目录 reminder（LA8）", () => {
  test("懒池非空 → 目录含名字、描述与指引；超长描述截断（LN4）", () => {
    const pending = [
      { name: "mcp_a", description: "短描述" },
      { name: "mcp_b", description: "x".repeat(120) },
    ];
    const text = lazyCatalogReminder(pending);
    expect(text).toBeDefined();
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("mcp_a");
    expect(text).toContain("短描述");
    expect(text).toContain("toolSearch");
    // 截断：80 字符 + 省略号，不包含完整的 120 个 x
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(100));
    expect(text).toContain("2 个延迟加载工具");
  });

  test("懒池为空 → 不注入（LA8）", () => {
    expect(lazyCatalogReminder([])).toBeUndefined();
  });
});

describe("端到端：manager 分流 + toolSearch + 调用（LA1 综合）", () => {
  test("connectAll 全量入懒池；toolSearch 发现后 definitionsFor 含该工具", async () => {
    const manager = new McpManager(stdioFixture("fx"));
    const registry = createDefaultRegistry();
    const reports = await manager.connectAll(registry);
    expect(reports[0]?.status).toBe("ok");

    // LA1：不直接注册、懒池 = 工具总数
    expect(registry.get("echo")).toBeUndefined();
    expect(registry.lazySize).toBe(2);

    // toolSearch 发现 echo
    const search = registry.get("toolSearch")!;
    const discovered = await search.execute({ query: "echo" }, { workDir: process.cwd() });
    expect(discovered.ok).toBe(true);
    expect(discovered.content).toContain("echo");
    expect(registry.get("echo")).toBeDefined();

    // 发现后进入工具列表（LA5 端到端形态）
    const definitions = registry.definitionsFor("openai") as Array<{ name: string }>;
    expect(definitions.map((item) => item.name)).toContain("echo");

    // 发现后的 echo 可正常调用（真实 stdio 子进程往返）
    const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: bypassGate() });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("echo:hi");

    await manager.disposeAll();
  });
});
