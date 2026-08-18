import { describe, expect, test } from "bun:test";
import { redact } from "../../src/tools/redact.js";

describe("redact", () => {
  test("OpenAI 风格密钥被脱敏", () => {
    const output = redact("api_key: sk-abcdefghijklmnopqrstuvwx");
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(output).toContain("[redacted]");
  });

  test("GitHub 令牌被脱敏", () => {
    expect(redact("ghp_0123456789abcdefghijklmnopqrstuvwxyz")).toBe("[redacted]");
    expect(redact("github_pat_0123456789abcdefghijklmno")).toBe("[redacted]");
  });

  test("AWS Access Key 被脱敏", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });

  test("Slack 令牌被脱敏", () => {
    expect(redact("xoxb-1234567890-abcdefghij")).toBe("[redacted]");
  });

  test("私钥整块被脱敏", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nlines\n-----END RSA PRIVATE KEY-----";
    expect(redact(key)).toBe("[redacted]");
  });

  test("Bearer 令牌被脱敏但保留前缀", () => {
    const output = redact("Authorization: Bearer abcdefghijklmnopqrstuv");
    expect(output).toContain("Bearer [redacted]");
    expect(output).not.toContain("abcdefghijklmnopqrstuv");
  });

  test("JWT 被脱敏", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    expect(redact(jwt)).toBe("[redacted]");
  });

  test("键值型只替换 value 保留键名", () => {
    const output = redact('password = "hunter2024"');
    expect(output).toContain("password");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("hunter2024");
  });

  test("普通文本与代码不被误伤", () => {
    expect(redact("这里讨论 token 的概念")).toBe("这里讨论 token 的概念");
    expect(redact("const skip = true;")).toBe("const skip = true;");
    expect(redact("password = req.body.password")).toBe("password = req.body.password");
    expect(redact("api_key?: string;")).toBe("api_key?: string;");
  });

  test("空字符串安全返回", () => {
    expect(redact("")).toBe("");
  });
});
