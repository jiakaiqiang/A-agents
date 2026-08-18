import type { JSONSchemaObject, JSONSchemaProperty } from "./types.js";

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

function typeMatches(property: JSONSchemaProperty, value: unknown): boolean {
  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}

/**
 * 按 Schema 校验模型给的参数（spec F12）。
 * 返回值只包含 Schema 声明过的字段，工具内部可安全按类型取值。
 */
export function validate(schema: JSONSchemaObject, args: unknown): ValidationResult {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, errors: ["参数必须是对象"] };
  }

  const input = args as Record<string, unknown>;
  const errors: string[] = [];
  const value: Record<string, unknown> = {};

  for (const name of schema.required) {
    if (input[name] === undefined || input[name] === null) {
      errors.push(`缺少必填参数 ${name}`);
    }
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    const current = input[name];
    if (current === undefined || current === null) {
      if (property.default !== undefined) value[name] = property.default;
      continue;
    }
    if (!typeMatches(property, current)) {
      errors.push(`参数 ${name} 类型应为 ${property.type}`);
      continue;
    }
    if (property.enum && !property.enum.includes(current as string)) {
      errors.push(`参数 ${name} 取值应为：${property.enum.join(" | ")}`);
      continue;
    }
    value[name] = current;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
