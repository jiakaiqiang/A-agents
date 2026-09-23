import { afterEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import type { SystemPromptSegments } from "../../src/prompt/builder.js";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { ok, type Tool } from "../../src/tools/types.js";

let captureSegments: ((segments: SystemPromptSegments) => void) | undefined;

mock.module("../../src/llm/client.js", () => ({
  createClient: async (_provider: unknown, segments: SystemPromptSegments) => {
    captureSegments?.(segments);
    return {
      async *stream() {
        return;
      },
    };
  },
}));

const { App } = await import("../../src/tui/app.js");

const mcpProbe: Tool = {
  name: "resolve-library-id",
  description: "[MCP: context7] Resolve a library ID",
  readOnly: false,
  parameters: { type: "object", properties: {}, required: [] },
  callSummary: () => "Mcp(context7.resolve-library-id)",
  async execute() {
    return ok("resolved", "resolved");
  },
};

afterEach(() => {
  captureSegments = undefined;
});

describe("App MCP registry 接线", () => {
  test("LLM 初始化使用启动层传入的 registry，而非新建默认 registry", async () => {
    const registry = createDefaultRegistry().register(mcpProbe);
    const segmentsReady = new Promise<SystemPromptSegments>((resolve) => {
      captureSegments = resolve;
    });

    const stdout = new PassThrough();
    stdout.on("data", () => undefined);
    Object.assign(stdout, { columns: 100, rows: 30 });

    const stdin = new PassThrough();
    Object.assign(stdin, {
      isTTY: true,
      setRawMode: () => stdin,
      ref: () => stdin,
      unref: () => stdin,
    });

    const instance = render(React.createElement(App, {
      providers: [{
        name: "test",
        protocol: "openai",
        base_url: "http://127.0.0.1",
        model: "test",
        api_key: "test",
      }],
      hooks: [],
      registry,
    }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    });

    try {
      const segments = await segmentsReady;
      expect(segments.stable).toContain("resolve-library-id");
    } finally {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
