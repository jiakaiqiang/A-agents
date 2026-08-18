import { describe, expect, test } from "bun:test";
import { validate } from "../../src/tools/schema.js";
import type { JSONSchemaObject } from "../../src/tools/types.js";

const schema: JSONSchemaObject = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "路径" },
    offset: { type: "integer", description: "起始行" },
    replace_all: { type: "boolean", description: "全量替换" },
    output_mode: { type: "string", description: "输出模式", enum: ["content", "count"] },
  },
  required: ["file_path"],
};

describe("validate", () => {
  test("合法参数原样通过", () => {
    const result = validate(schema, { file_path: "a.ts", offset: 3, replace_all: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ file_path: "a.ts", offset: 3, replace_all: true });
    }
  });

  test("必填缺失返回可读错误", () => {
    const result = validate(schema, { offset: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("file_path");
  });

  test("类型不符返回可读错误", () => {
    const result = validate(schema, { file_path: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("string");
  });

  test("integer 收到小数被拒", () => {
    const result = validate(schema, { file_path: "a.ts", offset: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("integer");
  });

  test("enum 越界列出允许值", () => {
    const result = validate(schema, { file_path: "a.ts", output_mode: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("content");
  });

  test("未声明字段被丢弃", () => {
    const result = validate(schema, { file_path: "a.ts", evil: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ file_path: "a.ts" });
  });

  test("非对象参数被拒", () => {
    expect(validate(schema, "string").ok).toBe(false);
    expect(validate(schema, [1, 2]).ok).toBe(false);
    expect(validate(schema, null).ok).toBe(false);
  });
});
