export interface JSONSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: string };
  default?: unknown;
}

export interface JSONSchemaObject {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required: string[];
  additionalProperties?: false;
}

// 失败原因分类：供测试断言与用户定位（spec N12）。
export type ToolErrorKind =
  | "invalid_params"
  | "out_of_scope"
  | "not_found"
  | "match_count"
  | "timeout"
  | "exec_failed"
  | "unknown_tool"
  | "unsupported";

export interface ToolResult {
  ok: boolean;
  content: string; // 回灌给模型的完整文本
  summary: string; // 工具行的一行摘要
  detail?: Record<string, unknown>;
  errorKind?: ToolErrorKind;
}

export interface ToolContext {
  workDir: string; // 启动目录，工具操作的唯一根
  signal?: AbortSignal;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchemaObject;
  /** 工具行展示用的调用摘要，例如 Read(src/x.ts)。 */
  callSummary(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function ok(content: string, summary: string, detail?: Record<string, unknown>): ToolResult {
  return { ok: true, content, summary, ...(detail ? { detail } : {}) };
}

export function fail(kind: ToolErrorKind, message: string, detail?: Record<string, unknown>): ToolResult {
  return {
    ok: false,
    content: `Error: ${message}`,
    summary: `failed: ${message}`,
    errorKind: kind,
    ...(detail ? { detail } : {}),
  };
}

/** 从已校验参数中取值的窄工具，避免各工具重复写类型断言。 */
export function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] as string : "";
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === "number" ? args[key] as number : undefined;
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}
