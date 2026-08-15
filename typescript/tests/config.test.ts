import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadConfig,
  resolveAPIKey,
} from "../src/config/config.js";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mewcode-config-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function writeConfig(contents: string): string {
  const file = join(directory, "config.yaml");
  writeFileSync(file, contents);
  return file;
}

describe("配置加载", () => {
  test("加载合法 provider", () => {
    const config = loadConfig(writeConfig(`providers:\n  - name: Test\n    protocol: anthropic\n    base_url: https://api.anthropic.com\n    model: claude-opus-5\n`));
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.model).toBe("claude-opus-5");
  });

  test("缺少字段时报错", () => {
    expect(() => loadConfig(writeConfig(`providers:\n  - name: Test\n    protocol: anthropic\n    base_url: https://api.anthropic.com\n`))).toThrow(ConfigError);
  });

  test("非法协议时报错", () => {
    expect(() => loadConfig(writeConfig(`providers:\n  - name: Test\n    protocol: unknown\n    base_url: https://example.com\n    model: demo\n`))).toThrow(ConfigError);
  });

  test("不存在的显式配置文件报错", () => {
    expect(() => loadConfig(join(directory, "missing.yaml"))).toThrow(ConfigError);
  });

  test("密钥优先读取配置，再回退环境变量", () => {
    const provider: { name: string; protocol: "anthropic"; base_url: string; model: string; api_key?: string } = { name: "A", protocol: "anthropic", base_url: "https://api.anthropic.com", model: "claude", api_key: "from-file" };
    expect(resolveAPIKey(provider)).toBe("from-file");
    delete provider.api_key;
    process.env.ANTHROPIC_API_KEY = "from-env";
    expect(resolveAPIKey(provider)).toBe("from-env");
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveAPIKey(provider)).toBe("");
  });
});
