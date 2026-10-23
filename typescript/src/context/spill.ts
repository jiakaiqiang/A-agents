// 第一层预防：超阈值工具结果存盘，对话内只留预览与路径（spec F2–F5）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHARS_PER_TOKEN, estimateChars, type TokenEstimator } from "./tokens.js";
import type { ToolResult } from "../tools/types.js";

export const SPILL_PREVIEW_CHARS = 500;
export const TOOL_SPILL_TOKENS = 2_000;
export const MESSAGE_SPILL_TOKENS = 4_000;

/** 单条结果的存盘结论：spilled=false 时 content 即原文（或 30K 截断原文）。 */
export interface SpillOutcome {
  content: string;
  spilled: boolean;
  filePath?: string;
}

function timestampName(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

/** 完整原文写入 <workDir>/.mewcode/tool-outputs/，返回 POSIX 风格路径；失败返回 null。 */
export function spillToFile(toolName: string, content: string, workDir: string): string | null {
  const directory = join(workDir, ".mewcode", "tool-outputs");
  try {
    mkdirSync(directory, { recursive: true });
    const safeName = toolName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/[. ]+$/g, "").slice(0, 80) || "tool";
    const path = join(directory, `${safeName}-${timestampName()}.txt`);
    writeFileSync(path, content, "utf-8");
    return path.split("\\").join("/");
  } catch {
    // 存盘是优化不是正确性依赖：失败回退原文，不打断工具流（spec N5）。
    return null;
  }
}

/** 预览 = 开头 ~500 字符 + 一行存盘提示。 */
export function buildPreview(content: string, filePath: string, previewChars = SPILL_PREVIEW_CHARS): string {
  const head = content.slice(0, previewChars);
  return `${head}\n\n[完整输出已存盘：${filePath}（${content.length} 字符）。需要细节请用 Read 读取该文件]`;
}

/**
 * 单条判定 + 存盘（spec F2）：估算 tokens 超过 TOOL_SPILL_TOKENS 才落盘。
 * 调用方需保证 result.content 已是最终回灌文本（30K 截断之后）。
 */
export async function maybeSpillResult(
  toolName: string,
  result: ToolResult,
  workDir: string,
  estimator: TokenEstimator,
  spillTokens = TOOL_SPILL_TOKENS,
  previewChars = SPILL_PREVIEW_CHARS,
): Promise<SpillOutcome> {
  // 单条结果是独立预算，不能使用会话级 usage 锚点，否则锚点的 inputTokens
  // 会把几字节的小结果误判成数千 tokens。
  const tokens = Math.ceil(estimateChars({
    role: "user",
    content: "",
    toolResults: [{ toolUseId: "spill-check", content: result.content }],
  }) / CHARS_PER_TOKEN);
  if (tokens <= spillTokens) {
    return { content: result.content, spilled: false };
  }
  const filePath = spillToFile(toolName, result.content, workDir);
  if (!filePath) return { content: result.content, spilled: false };
  return { content: buildPreview(result.content, filePath, previewChars), spilled: true, filePath };
}
