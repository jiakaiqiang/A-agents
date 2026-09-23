import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import {
  ConfigError,
  expandEnvVars,
  loadConfig,
  mergeConfig,
  parseMcpServers,
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

describe("MCP 配置解析", () => {
  test("map 声明的 stdio 与 http Server 都被解析（AC1）", () => {
    const yaml = `mcp_servers:
  db:
    type: stdio
    command: node
    args: ["server.js"]
    env:
      DB_URL: postgres://x
  web:
    type: http
    url: https://mcp.example.com/rpc
    headers:
      Authorization: Bearer tok
`;
    const parsed = load(yaml) as Record<string, unknown>;
    const { servers, warnings } = parseMcpServers(parsed.mcp_servers, "test.yaml");
    expect(warnings).toHaveLength(0);
    expect(servers["db"]?.type).toBe("stdio");
    expect(servers["db"]?.command).toBe("node");
    expect(servers["db"]?.args).toEqual(["server.js"]);
    expect(servers["db"]?.env?.DB_URL).toBe("postgres://x");
    expect(servers["web"]?.type).toBe("http");
    expect(servers["web"]?.url).toBe("https://mcp.example.com/rpc");
    expect(servers["web"]?.headers?.Authorization).toBe("Bearer tok");
  });  test("${VAR} 展开：env 前置引用、进程变量、未定义出警告（AC2）", () => {
    process.env.MEWCODE_TEST_TOKEN = "tok-123";
    try {
      const raw = {
        app: {
          type: "stdio",
          command: "run",
          env: {
            BASE: "alpha",
            DERIVED: "${BASE}-suffix",
            TOKEN: "${MEWCODE_TEST_TOKEN}",
            MISSING: "${MEWCODE_TEST_UNDEFINED_VAR}",
          },
        },
      };
      const { servers, warnings } = parseMcpServers(raw, "test.yaml");
      const env = servers["app"]?.env ?? {};
      expect(env["DERIVED"]).toBe("alpha-suffix");
      expect(env["TOKEN"]).toBe("tok-123");
      expect(env["MISSING"]).toBe("");
      expect(warnings.some((text) => text.includes("MEWCODE_TEST_UNDEFINED_VAR"))).toBe(true);
    } finally {
      delete process.env.MEWCODE_TEST_TOKEN;
    }
  });

  test("expandEnvVars：未定义变量展开为空串并产生警告（AC2）", () => {
    const { value, warnings } = expandEnvVars("prefix-${NO_SUCH_VAR}-suffix", () => undefined);
    expect(value).toBe("prefix--suffix");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("NO_SUCH_VAR");
  });

  test("同名 Server 键级覆盖：项目级整体替换用户级（AC3）", () => {
    const base = {
      providers: [], hooks: [], mcp_warnings: [],
      mcp_servers: { db: { type: "stdio" as const, enabled: true, command: "old" } },
    };
    const override = {
      providers: [], hooks: [], mcp_warnings: [],
      mcp_servers: { db: { type: "http" as const, enabled: true, url: "https://new.example.com" } },
    };
    const merged = mergeConfig(base, override);
    expect(merged.mcp_servers["db"]?.type).toBe("http");
    expect(merged.mcp_servers["db"]?.url).toBe("https://new.example.com");
    expect(merged.mcp_servers["db"]?.command).toBeUndefined();
  });

  test("非法 Server 项跳过并出警告，不抛异常（N4）", () => {
    const raw = {
      good: { type: "stdio", command: "node" },
      noCommand: { type: "stdio" },
      noUrl: { type: "http" },
      badUrl: { type: "http", url: "not-a-url" },
      notObject: "oops",
    };
    const { servers, warnings } = parseMcpServers(raw, "test.yaml");
    expect(Object.keys(servers)).toEqual(["good"]);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });

  test("enabled: false 保留在配置里（AC3 后半由 manager 处理）", () => {
    const raw = { off: { type: "stdio", command: "node", enabled: false } };
    const { servers } = parseMcpServers(raw, "test.yaml");
    expect(servers["off"]?.enabled).toBe(false);
  });

  test("timeout 与默认 type（stdio）解析", () => {
    const raw = { slow: { command: "node", timeout: 30_000 } };
    const { servers, warnings } = parseMcpServers(raw, "test.yaml");
    expect(warnings).toHaveLength(0);
    expect(servers["slow"]?.type).toBe("stdio");
    expect(servers["slow"]?.timeout).toBe(30_000);
  });
});
