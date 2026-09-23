// MCP 管理器（plan 模块 E）：并行连接全部 Server、延迟登记工具、汇总报告、退出清理。
// 单个 Server 失败只降级，不拖垮启动（spec F9）；连接由本单例持有（spec F6）。
// 延迟加载（docs/specs/lazy-tools.md）：懒池唯一容器是 ToolRegistry（LN1 单一事实来源），
// 本管理器不维护第二份索引；loader 闭包持有 client，发现时才生成完整 Tool。

import type { ToolRegistry } from "../tools/registry.js";
import { createMcpTool } from "./adapter.js";
import { McpClient } from "./client.js";
import { HttpTransport } from "./transport-http.js";
import { StdioTransport } from "./transport-stdio.js";
import type { McpServerConfig, McpServerReport, McpTransport } from "./types.js";

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly transports = new Map<string, McpTransport>();

  constructor(private readonly serverConfigs: Record<string, McpServerConfig>) {}

  /**
   * 并行连接全部启用的 Server（spec F4）：握手 → 列工具 → 延迟登记。
   * 每个 Server 独立超时与降级；报告四态供 TUI 呈现（spec F16）。
   */
  async connectAll(registry: ToolRegistry): Promise<McpServerReport[]> {
    const names = Object.keys(this.serverConfigs);
    //对于没个mcpserver 都添加上内置的工具
    const reports = await Promise.all(names.map((name) => this.connectOne(name, registry)));
    return reports;
  }

  private async connectOne(name: string, registry: ToolRegistry): Promise<McpServerReport> {
    const config = this.serverConfigs[name];
    if (!config) return { name, status: "failed", reason: "配置缺失" };
    if (!config.enabled) return { name, status: "disabled" };

    try {
      // 获取的是那种的方式 stdio 还是 http
      const transport = this.createTransport(config);
      const client = new McpClient(config, transport);
      await client.connect(); // 握手超时在 client 内部执行
      const tools = await client.listTools();

      // 延迟分流（spec LF1）：全部登记懒池，不直接 register。
      // loader 闭包持有 client，发现时才生成完整 Tool。
      const registered: string[] = [];
      const warnings: string[] = [];
      for (const def of tools) {
        const registerName = this.resolveRegisterName(registry, name, def.name);
        if (!registerName) {
          warnings.push(def.name);
          continue;
        }
        registry.registerLazy({
          name: registerName,
          description: def.description ?? def.name,
          loader: async () => createMcpTool(name, client, { ...def, name: registerName }),
        });
        registered.push(registerName);
      }

      this.clients.set(name, client);
      this.transports.set(name, transport);
      if (warnings.length > 0) {
        // 前缀后仍冲突的工具跳过：极少数情况（两个 Server 提供同名工具且都带前缀冲突），不静默。
        return { name, status: "failed", reason: `工具注册名冲突：${warnings.join(", ")}` };
      }
      return { name, status: "ok", toolCount: registered.length, tools: registered };
    } catch (error) {
      // 失败时清理已 spawn 的子进程，不留僵尸（spec N3）。
      const transport = this.transports.get(name);
      if (transport) await transport.close();
      this.transports.delete(name);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("超时")) {
        const timeoutMs = config.timeout ?? 10_000;
        return { name, status: "timeout", timeoutMs };
      }
      return { name, status: "failed", reason: message };
    }
  }

  /** 注册名判定（spec F8）：原名可用用原名，冲突加 Server 前缀，再冲突跳过。 */
  private resolveRegisterName(registry: ToolRegistry, serverName: string, toolName: string): string | undefined {
    if (!registry.get(toolName) && !registry.getLazy(toolName)) return toolName;
    const prefixed = `${serverName}_${toolName}`;
    if (!registry.get(prefixed) && !registry.getLazy(prefixed)) return prefixed;
    return undefined;
  }

  private createTransport(config: McpServerConfig): McpTransport {
    if (config.type === "http") {
      if (!config.url) throw new Error("http 类型缺少 url");
      return new HttpTransport(config.url, config.headers ?? {});
    }
    if (!config.command) throw new Error("stdio 类型缺少 command");
    return new StdioTransport(config.command, config.args ?? [], config.env);
  }

  /** 关闭全部连接：stdio kill 子进程，http 空操作（spec F6、N3）。
   * 懒池条目留在 registry（LF6 修订）：loader 持有的 client 已 markDisconnected，
   * 后续发现后调用会得到明确的"已断开"失败并回灌，不产生僵尸进程。 */
  async disposeAll(): Promise<void> {
    const closes = [...this.transports.values()].map((transport) => transport.close());
    this.transports.clear();
    for (const client of this.clients.values()) client.markDisconnected();
    this.clients.clear();
    await Promise.allSettled(closes);
  }
}

// 模块级单例（plan D10）：main 与测试共用一份实例。
let singleton: McpManager | null = null;

export function setMcpManager(manager: McpManager | null): void {
  singleton = manager;
}

export function getMcpManager(): McpManager | null {
  return singleton;
}
