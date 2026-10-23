import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LLMClient } from "../../src/llm/client.js";
import { emptyUsage } from "../../src/llm/events.js";

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mewcode-memory-"));
  const workDir = join(root, "project");
  const homeDir = join(root, "home");
  mkdirSync(workDir);
  mkdirSync(homeDir);
  return {
    root, workDir, homeDir,
    write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, "utf8"); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export function textClient(text: string): LLMClient {
  return { async *stream() {
    yield { type: "text_delta", text };
    yield { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() };
  } };
}
