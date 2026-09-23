// stdio 传输用例：行分帧收发往返、子进程退出断开、close 清理（spec AC4 基座、AC6）。

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { StdioTransport } from "../../src/mcp/transport-stdio.js";

const ECHO_SERVER = join(import.meta.dir, "fixtures", "echo-server.ts");

describe("StdioTransport", () => {
  test("按行收发：多行消息各自完整投递（AC4 传输基座）", async () => {
    const transport = new StdioTransport(process.execPath, [ECHO_SERVER], {});
    const received: string[] = [];
    const done = new Promise<void>((resolve) => {
      transport.onMessage((text) => {
        received.push(text);
        if (received.length === 2) resolve();
      });
    });
    transport.onClose(() => undefined);
    await transport.send(JSON.stringify({ seq: 1 }));
    await transport.send(JSON.stringify({ seq: 2 }));
    await done;
    expect(received.map((text) => JSON.parse(text).seq)).toEqual([1, 2]);
    await transport.close();
  });

  test("子进程退出触发 onClose 且 reason 含退出信息", async () => {
    const transport = new StdioTransport(process.execPath, ["-e", "process.exit(0)"], {});
    const closed = new Promise<string>((resolve) => transport.onClose(resolve));
    const reason = await closed;
    expect(reason).toContain("子进程退出");
  });

  test("close() 后子进程终止（AC6）", async () => {
    const transport = new StdioTransport(process.execPath, [ECHO_SERVER], {});
    const pid = transport.pid;
    expect(pid).toBeDefined();
    // 先做一次往返确认子进程活着
    const done = new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    transport.onClose(() => undefined);
    await transport.send(JSON.stringify({ ping: true }));
    await done;
    await transport.close();
    // poll 等待退出（Windows 上 taskkill 异步）
    for (let i = 0; i < 50; i++) {
      const probe = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { windowsHide: true });
      if (probe.status !== 0 || !String(probe.stdout).includes(String(pid))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const probe = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { windowsHide: true });
    expect(String(probe.stdout)).not.toContain(String(pid));
  }, 15_000);
});
