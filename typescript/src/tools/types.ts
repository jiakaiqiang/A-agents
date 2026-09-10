import type { PermissionGate } from "../permission/types.js";

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
  | "unsupported"
  | "cancelled" // 批次被中断，该调用未执行
  | "permission_denied"; // 权限判定拒绝，单列以便与越界、参数错误区分（权限 spec N4）

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
  /** 权限判定所需的档位、规则与确认回调；缺省时需要确认的调用一律拒绝（权限 spec F1）。 */
  permission?: PermissionGate;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchemaObject;
  /** 无副作用：可与同批工具并发执行，且计划模式下可用。 */
  readonly readOnly: boolean;
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
