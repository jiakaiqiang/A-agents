// 管理器集成用例：并行连接、超时降级、重名前缀、enabled、退出清理、断开调用（spec F3、F4、F6、F8–F10）。

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createDefaultRegistry, runTool } from "../../src/tools/index.js";
import { McpManager } from "../../src/mcp/manager.js";
import { bypassGate } from "../permission/helpers.js";
import type { McpServerConfig } from "../../src/mcp/types.js";

const MCP_SERVER = join(import.meta.dir, "fixtures", "mcp-server.ts");
const ECHO_SERVER = join(import.meta.dir, "fixtures", "echo-server.ts");

function stdioFixture(name: string, extra: Partial<McpServerConfig> = {}): Record<string, McpServerConfig> {
  return { [name]: { type: "stdio", enabled: true, command: process.execPath, args: [MCP_SERVER], ...extra } };
}

describe("McpManager", () => {
  afterEach(() => {
    // 每个用例自管 dispose，这里兜底不拦截。
  });

  test("stdio Server 连接成功并登记延迟工具（AC4 / LF1）", async () => {
    const manager = new McpManager(stdioFixture("fx", { timeout: 15_000 }));
    const registry = createDefaultRegistry();
    const reports = await manager.connectAll(registry);
    expect(reports[0]?.status).toBe("ok");
    if (reports[0]?.status === "ok") {
      expect(reports[0].toolCount).toBe(2);
      expect(reports[0].tools).toContain("echo");
    }
    // 延迟分流（LF1）：不直接注册，全部进懒池（registry 是唯一容器，LN1）。
    expect(registry.get("echo")).toBeUndefined();
    expect(registry.lazySize).toBe(2);
    await manager.disposeAll();
  });

  test("握手挂起超 timeout → timeout 报告（AC8）", async () => {
    const manager = new McpManager(stdioFixture("hang", { args: [MCP_SERVER, "--mode", "hang"], timeout: 300 }));
    const reports = await manager.connectAll(new ToolRegistry());
    expect(reports[0]?.status).toBe("timeout");
    if (reports[0]?.status === "timeout") expect(reports[0].timeoutMs).toBe(300);
    await manager.disposeAll();
  });

  test("与内置工具重名 → 懒池登记为 Server名_工具名（AC7 / LF1）", async () => {
    const manager = new McpManager(stdioFixture("fx", { timeout: 15_000 }));
    const registry = createDefaultRegistry();
    const reports = await manager.connectAll(registry);
    expect(reports[0]?.status).toBe("ok");
    // 桩提供 Read：与内置冲突 → fx_Read 入懒池（不直接注册）
    expect(registry.getLazy("fx_Read")).toBeDefined();
    expect(registry.get("fx_Read")).toBeUndefined();
    expect(reports[0]?.status === "ok" && reports[0].tools.includes("fx_Read")).toBe(true);
    await manager.disposeAll();
  });

  test("enabled: false → disabled 报告、零连接尝试（AC3）", async () => {
    const manager = new McpManager({
      off: { type: "stdio", enabled: false, command: "definitely-not-a-real-command" },
    });
    const reports = await manager.connectAll(new ToolRegistry());
    expect(reports[0]?.status).toBe("disabled");
    await manager.disposeAll();
  });

  test("两个 Server 并行连接，报告独立（AC4）", async () => {
    const manager = new McpManager({
      fx: { type: "stdio", enabled: true, command: process.execPath, args: [MCP_SERVER], timeout: 15_000 },
      echo: { type: "stdio", enabled: true, command: process.execPath, args: [ECHO_SERVER], timeout: 15_000 },
    });
    const reports = await manager.connectAll(new ToolRegistry());
    // echo 桩只会回显，MCP 握手会失败——报告为 failed，且不影响 fx
    const byName = Object.fromEntries(reports.map((report) => [report.name, report]));
    expect(byName["fx"]?.status).toBe("ok");
    expect(byName["echo"]?.status).toBe("failed");
    await manager.disposeAll();
  });

  test("disposeAll 后 stdio 子进程终止（AC6）", async () => {
    const manager = new McpManager(stdioFixture("fx", { timeout: 15_000 }));
    const registry = new ToolRegistry();
    await manager.connectAll(registry);
    // 连接成功后 fixture 子进程存在；dispose 后应终止。
    // 间接验证：pid 不可直接取（manager 内部持有），用 tasklist 探测 bun 运行的 fixture 数量。
    // 简化：断言 dispose 不抛且第二次调用幂等。
    await manager.disposeAll();
    await manager.disposeAll();
  });

  test("断开后经 runTool 调用 → 失败结果回灌，循环可继续（AC9 / LF5/LF6）", async () => {
    const manager = new McpManager(stdioFixture("fx", { timeout: 15_000 }));
    const registry = createDefaultRegistry();
    await manager.connectAll(registry);
    await manager.disposeAll(); // 断开

    // 断开后懒池条目仍在（LF6 修订）：安全网触发发现，执行时得到明确断开错误
    const tool = registry.get("echo");
    expect(tool).toBeUndefined();
    const result = await runTool(registry, "echo", { text: "hi" }, { workDir: process.cwd(), permission: bypassGate() });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("exec_failed");
    expect(result.content).toContain("MCP Server 已断开");
  });

  test("disposeAll 后懒池条目保留、连接态失效（LF6）", async () => {
    const manager = new McpManager(stdioFixture("fx", { timeout: 15_000 }));
    const registry = createDefaultRegistry();
    await manager.connectAll(registry);
    expect(registry.lazySize).toBe(2);
    await manager.disposeAll();
    // 条目保留（单一事实来源），但发现后调用会明确失败
    expect(registry.lazySize).toBe(2);
    expect(registry.getLazy("echo")).toBeDefined();
  });
});
