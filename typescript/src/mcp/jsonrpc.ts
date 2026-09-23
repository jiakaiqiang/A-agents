// JSON-RPC 2.0 协议核心（plan 模块 B）。
// 按 id 做异步配对；无 id 的通知静默丢弃（spec F5）。
// 字节流由注入的 McpTransport 收发，本层只认完整 JSON 文本。

import type { McpTransport } from "./types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private closed = false;

  constructor(private readonly transport: McpTransport) {
    transport.onMessage((text) => this.handleMessage(text)); // 设个是接受transport.send发过来的消息，去处理jsonrpc的消息
    transport.onClose((reason) => this.handleClose(reason));
  }

  /** 发出请求并等待按 id 配对的响应。 */
  send(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`连接已关闭，无法发送 ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transport.send(JSON.stringify(request)).catch((error: unknown) => {
        // 发送失败立即兑付，不让该请求挂在表里等 onClose。
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          const message = error instanceof Error ? error.message : String(error);
          entry.reject(new Error(`发送失败：${message}`));
        }
      });
    });
  }

  /** 发无 id 通知，不进配对表、不等待响应。 */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error(`连接已关闭，无法发送 ${method}`);
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.transport.send(JSON.stringify(notification));
  }

  /** 收到一条完整 JSON 文本：响应喂配对表，通知与畸形消息丢弃（spec F5、N6）。 */
  handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // 畸形 JSON 静默丢弃
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    if (typeof message.id !== "number") return; // 无 id 的通知：静默丢弃

    const entry = this.pending.get(message.id);
    if (!entry) return; // 未知 id（超时后迟到的响应）：丢弃
    this.pending.delete(message.id);
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { code?: unknown; message?: unknown };
      const detail = typeof error.message === "string" ? error.message : JSON.stringify(message.error);
      entry.reject(new Error(`Server 错误（code ${String(error.code)}）：${detail}`));
      return;
    }
    entry.resolve(message.result);
  }

  /** transport 断开：全部 pending 按失败兑付，错误信息含断开原因。 */
  handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`连接已断开：${reason}`);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
