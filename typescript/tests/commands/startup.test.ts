import { expect, test } from "bun:test";
import { join } from "node:path";

const builtins = join(import.meta.dir, "../../src/commands/builtins/index.ts").replaceAll("\\", "/");

async function runScript(source: string) {
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("内置命令撞名：输出冲突双方并以退出码 1 结束，后续代码不执行", async () => {
  const { code, stdout, stderr } = await runScript(`
    const { createCommandsOrExit, BUILTIN_COMMANDS } = await import(${JSON.stringify(builtins)});
    const status = BUILTIN_COMMANDS.find((def) => def.name === "status");
    createCommandsOrExit([...BUILTIN_COMMANDS, { ...status, name: "stats", aliases: ["h"] }]);
    console.log("SHOULD_NOT_REACH");
  `);
  expect(code).toBe(1);
  expect(stderr).toContain("命令名冲突：/h 同时属于 /help 与 /stats");
  expect(stdout).not.toContain("SHOULD_NOT_REACH");
}, 15_000);

test("无冲突时正常返回注册中心", async () => {
  const { code, stdout } = await runScript(`
    const { createCommandsOrExit } = await import(${JSON.stringify(builtins)});
    console.log("COUNT=" + createCommandsOrExit().list().length);
  `);
  expect(code).toBe(0);
  expect(stdout).toContain("COUNT=14");
}, 15_000);
