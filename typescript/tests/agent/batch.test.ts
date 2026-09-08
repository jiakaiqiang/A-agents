import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBatches, runBatches, type PendingCall } from "../../src/agent/batch.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ToolResultBlock } from "../../src/conversation/conversation.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ok, type Tool } from "../../src/tools/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mewcode-batch-"));
  temporaryDirectories.push(directory);
  return directory;
}

function call(id: string, name: string, args: Record<string, unknown> = {}): PendingCall {
  return { id, name, arguments: args };
}

/** 可控桩工具：指定只读性、耗时与是否抛异常。 */
function stub(name: string, readOnly: boolean, options: { sleepMs?: number; throws?: boolean } = {}): Tool {
  return {
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {}, required: [] },
    readOnly,
    callSummary: () => `${name}()`,
    async execute() {
      if (options.sleepMs) await new Promise((resolve) => setTimeout(resolve, options.sleepMs));
      if (options.throws) throw new Error(`${name} boom`);
      return ok(`${name} done`, `${name} ok`);
    },
  };
}

async function drain(
  generator: AsyncGenerator<AgentEvent, ToolResultBlock[]>,
): Promise<{ events: AgentEvent[]; results: ToolResultBlock[] }> {
  const events: AgentEvent[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done) return { events, results: step.value };
    events.push(step.value);
  }
}

describe("planBatches", () => {
  const registry = createDefaultRegistry();

  test("保序分段：读写读搜切成三批", () => {
    const batches = planBatches([
      call("c1", "Read"),
      call("c2", "Write"),
      call("c3", "Read"),
      call("c4", "Grep"),
    ], registry);

    expect(batches.map((batch) => ({
      concurrent: batch.concurrent,
      names: batch.calls.map((item) => item.name),
    }))).toEqual([
      { concurrent: true, names: ["Read"] },
      { concurrent: false, names: ["Write"] },
      { concurrent: true, names: ["Read", "Grep"] },
    ]);
  });

  test("全只读切成一个并发批", () => {
    const batches = planBatches([call("c1", "Read"), call("c2", "Glob"), call("c3", "Grep")], registry);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.concurrent).toBe(true);
    expect(batches[0]!.calls).toHaveLength(3);
  });

  test("全副作用切成等量串行批", () => {
    const batches = planBatches([call("c1", "Write"), call("c2", "Edit"), call("c3", "Bash")], registry);
    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => !batch.concurrent && batch.calls.length === 1)).toBe(true);
  });

  test("未知工具单独成串行批", () => {
    const batches = planBatches([call("c1", "Read"), call("c2", "Nope"), call("c3", "Read")], registry);
    expect(batches.map((batch) => ({ concurrent: batch.concurrent, names: batch.calls.map((i) => i.name) })))
      .toEqual([
        { concurrent: true, names: ["Read"] },
        { concurrent: false, names: ["Nope"] },
        { concurrent: true, names: ["Read"] },
      ]);
  });

  test("空调用列表返回空批次", () => {
    expect(planBatches([], registry)).toEqual([]);
  });
});

describe("runBatches", () => {
  test("并发批真并发且结果按原始顺序回写", async () => {
    const registry = new ToolRegistry()
      .register(stub("SlowA", true, { sleepMs: 60 }))
      .register(stub("SlowB", true, { sleepMs: 60 }));
    const calls = [call("c1", "SlowA"), call("c2", "SlowB")];
    const batches = planBatches(calls, registry);
    expect(batches).toHaveLength(1);

    const started = Date.now();
    const { events, results } = await drain(runBatches(batches, registry, { workDir: process.cwd() }));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(120);
    expect(results.map((item) => item.toolUseId)).toEqual(["c1", "c2"]);
    // 两条 tool_start 都早于第一条 tool_end。
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(2);
    expect(events.findIndex((event) => event.type === "tool_end"))
      .toBeGreaterThan(events.map((event) => event.type).lastIndexOf("tool_start"));
  });

  test("重复运行结果顺序稳定", async () => {
    const registry = new ToolRegistry()
      .register(stub("FastA", true, { sleepMs: 30 }))
      .register(stub("SlowB", true, { sleepMs: 5 }));
    const calls = [call("c1", "FastA"), call("c2", "SlowB")];
    for (let round = 0; round < 3; round += 1) {
      const { results } = await drain(runBatches(planBatches(calls, registry), registry, { workDir: process.cwd() }));
      expect(results.map((item) => item.toolUseId)).toEqual(["c1", "c2"]);
    }
  });

  test("并发批内单个失败不影响同批其他调用", async () => {
    const registry = new ToolRegistry()
      .register(stub("Good", true))
      .register(stub("Bad", true, { throws: true }));
    const { results } = await drain(runBatches(
      planBatches([call("c1", "Good"), call("c2", "Bad")], registry),
      registry,
      { workDir: process.cwd() },
    ));

    expect(results[0]!.isError).toBeFalsy();
    expect(results[1]!.isError).toBe(true);
    expect(results[1]!.content).toContain("Bad boom");
  });

  test("串行批的副作用对后续批可见", async () => {
    const workDir = makeTemporaryDirectory();
    const registry = createDefaultRegistry();
    const calls = [
      call("c1", "Write", { file_path: "note.txt", content: "新内容" }),
      call("c2", "Read", { file_path: "note.txt" }),
    ];
    const batches = planBatches(calls, registry);
    expect(batches.map((batch) => batch.concurrent)).toEqual([false, true]);

    const { results } = await drain(runBatches(batches, registry, { workDir }));
    expect(results[0]!.isError).toBeFalsy();
    expect(results[1]!.content).toContain("新内容");
  });

  test("参数 JSON 解析失败的调用不执行", async () => {
    let executed = false;
    const tool: Tool = {
      ...stub("Probe", false),
      async execute() {
        executed = true;
        return ok("ran", "ran");
      },
    };
    const registry = new ToolRegistry().register(tool);
    const { results } = await drain(runBatches(
      planBatches([{ id: "c1", name: "Probe", arguments: {}, parseError: "Unexpected end of JSON input" }], registry),
      registry,
      { workDir: process.cwd() },
    ));

    expect(executed).toBe(false);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("无法解析");
  });

  test("已取消时全部调用产出 cancelled 结果且事件完整", async () => {
    const workDir = makeTemporaryDirectory();
    writeFileSync(join(workDir, "a.txt"), "x");
    const registry = createDefaultRegistry();
    const controller = new AbortController();
    controller.abort();

    const calls = [
      call("c1", "Read", { file_path: "a.txt" }),
      call("c2", "Write", { file_path: "b.txt", content: "y" }),
      call("c3", "Grep", { pattern: "x" }),
    ];
    const { events, results } = await drain(runBatches(
      planBatches(calls, registry),
      registry,
      { workDir, signal: controller.signal },
    ));

    expect(results).toHaveLength(3);
    expect(results.map((item) => item.toolUseId)).toEqual(["c1", "c2", "c3"]);
    expect(results.every((item) => item.isError === true)).toBe(true);
    expect(results.every((item) => item.content.includes("本轮已中断"))).toBe(true);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(3);
  });

  test("未知工具回灌 unknown_tool 且与调用配对", async () => {
    const registry = createDefaultRegistry();
    const { results } = await drain(runBatches(
      planBatches([call("c1", "Nope")], registry),
      registry,
      { workDir: process.cwd() },
    ));
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("未知工具");
  });
});
