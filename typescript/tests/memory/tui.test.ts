import { expect, test } from "bun:test";
import { join } from "node:path";

test("真实 Ink 输入输出：运行中输入、取消恢复、同档续写、快照与退出", async () => {
  // 独立进程隔离其他测试的 mock.module，同时走真实 HTTP provider 适配器。
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/tui.tsx")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("TUI_MEMORY_OK");
}, 25_000);
