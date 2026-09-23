// Streamable HTTP 传输（plan 模块 C）：每次 POST 一条 JSON-RPC 消息，
// 响应兼容 application/json 与 text/event-stream 两种形态（spec F4）。
// 无长连接：send 每次独立请求；close 为空操作。

import type { McpTransport } from "./types.js";

export class HttpTransport implements McpTransport {
  private messageCallback: ((text: string) => void) | null = null;
  private closeCallback: ((reason: string) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async send(text: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...this.headers,
        },
        body: text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.closeCallback?.(`HTTP 请求失败：${message}`);
      throw new Error(`HTTP 请求失败：${message}`);
    }

    if (!response.ok) {
      const reason = `HTTP ${response.status}`;
      this.closeCallback?.(reason);
      throw new Error(reason);
    }
    if (response.status === 204) return; // 成功但无响应体（通知类）

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      this.consumeSse(await response.text());
      return;
    }
    if (contentType.includes("application/json")) {
      const body = await response.text();
      if (body.trim()) this.messageCallback?.(body);
      return;
    }
    const reason = `不支持的响应类型：${contentType || "无 content-type"}`;
    this.closeCallback?.(reason);
    throw new Error(reason);
  }

  /** SSE 形态：逐行扫描，取 data: 前缀后的 JSON；空 data 行或注释行跳过。 */
  private consumeSse(body: string): void {
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload) this.messageCallback?.(payload);
    }
  }

  onMessage(callback: (text: string) => void): void {
    this.messageCallback = callback;
  }

  onClose(callback: (reason: string) => void): void {
    this.closeCallback = callback;
  }

  async close(): Promise<void> {
    // 无长连接，无需清理。
  }
}
