import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRecorder, Message } from "../conversation/conversation.js";
import { SUMMARY_PREFIX } from "../context/compactor.js";
import { SESSION_EXPIRE_MS, SESSION_LIST_LIMIT, SESSION_TITLE_MAX_CHARS } from "../tools/limits.js";
import { resolveInside } from "../tools/paths.js";
import { isHeldByOther, sessionLockPath } from "./lock.js";

export type SessionRecord =
  | { type: "message"; ts: string; message: Message }
  | { type: "compaction"; ts: string; messages: Message[] };

export interface SessionInfo {
  id: string;
  title: string;
  messageCount: number;
  lastActive: Date;
  inUse: boolean; // 被其他存活进程占用（F15）
}

export interface RebuildResult {
  messages: Message[];
  summaryCount: number;
  skippedLines: number;
  truncatedFrom: number | null;
  lastTimestamp: Date | null;
}

const SESSION_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function sessionsDir(workDir: string): string {
  const result = resolveInside(workDir, ".mewcode/sessions");
  if (!result.ok) throw new Error(result.reason);
  return result.absolute;
}

function sessionPath(workDir: string, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error("会话 ID 不合法");
  const result = resolveInside(sessionsDir(workDir), `${id}.jsonl`);
  if (!result.ok) throw new Error(result.reason);
  return result.absolute;
}

export function newSessionId(now = new Date(), exists: (id: string) => boolean = () => false): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const prefix = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let id: string;
  do { id = `${prefix}-${randomBytes(2).toString("hex")}`; } while (exists(id));
  return id;
}

export class SessionWriter implements HistoryRecorder {
  private failed = false;
  private initialized = false;

  constructor(readonly id: string, private readonly workDir: string, private readonly onError?: (message: string) => void) {}

  onAppend(message: Message): void {
    this.append({ type: "message", ts: new Date().toISOString(), message });
  }

  onReplace(messages: Message[]): void {
    this.append({ type: "compaction", ts: new Date().toISOString(), messages });
  }

  private append(record: SessionRecord): void {
    if (this.failed) return;
    try {
      const path = sessionPath(this.workDir, this.id);
      let prefix = "";
      if (!this.initialized) {
        mkdirSync(sessionsDir(this.workDir), { recursive: true });
        // 崩溃可能留下无换行的半条记录；先隔开它，不能吞掉恢复后的第一条消息。
        if (existsSync(path)) {
          const fd = openSync(path, "r");
          try {
            const size = fstatSync(fd).size;
            const last = Buffer.alloc(1);
            if (size && readSync(fd, last, 0, 1, size - 1) && last[0] !== 10) prefix = "\n";
          } finally { closeSync(fd); }
        }
        this.initialized = true;
      }
      appendFileSync(path, prefix + JSON.stringify(record) + "\n", "utf8");
    } catch (error) {
      this.failed = true;
      try { this.onError?.(error instanceof Error ? error.message : String(error)); } catch { /* 告警回调也不能中断对话。 */ }
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is Message {
  if (!object(value) || !["user", "assistant", "system"].includes(String(value.role)) || typeof value.content !== "string") return false;
  if (value.thinkingBlocks !== undefined && (!Array.isArray(value.thinkingBlocks) || !value.thinkingBlocks.every((block) =>
    object(block) && typeof block.thinking === "string" && typeof block.signature === "string"))) return false;
  if (value.toolUses !== undefined && (value.role !== "assistant" || !Array.isArray(value.toolUses) || !value.toolUses.every((use) =>
    object(use) && typeof use.id === "string" && !!use.id && typeof use.name === "string" && object(use.arguments)))) return false;
  if (value.toolResults !== undefined && (value.role !== "user" || !Array.isArray(value.toolResults) || !value.toolResults.every((result) =>
    object(result) && typeof result.toolUseId === "string" && typeof result.content === "string" && (result.isError === undefined || typeof result.isError === "boolean")))) return false;
  if (value.display !== undefined && typeof value.display !== "string") return false;
  return true;
}

function parseRecord(line: string): SessionRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!object(value) || typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts))) return null;
    if (value.type === "message" && isMessage(value.message)) return value as SessionRecord;
    if (value.type === "compaction" && Array.isArray(value.messages) && value.messages.every(isMessage)) return value as SessionRecord;
  } catch { /* 损坏行跳过，保留其余可读记录。 */ }
  return null;
}

export function readSessionLines(workDir: string, id: string): string[] {
  return readFileSync(sessionPath(workDir, id), "utf8").split(/\r?\n/).filter((line) => line.trim());
}
//  历史

export function rebuildHistory(lines: string[]): RebuildResult {
  let messages: Message[] = [];
  let summaryCount = 0;
  let skippedLines = 0;
  let lastTimestamp: Date | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!record) { skippedLines++; continue; }
    lastTimestamp = new Date(record.ts);
    if (record.type === "compaction") {
      messages = [...record.messages];
      summaryCount = messages.filter((message) => message.content.startsWith(SUMMARY_PREFIX)).length;
    } else messages.push(record.message);
  }
  let truncatedFrom: number | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && message.toolUses?.length) {
      const next = messages[index + 1];
      const ids = new Set(next?.toolResults?.map((result) => result.toolUseId));
      if (next?.role !== "user" || !message.toolUses.every((use) => ids.has(use.id))) {
        truncatedFrom = index;
        break;
      }
    }
    // 坏行也可能正好是工具调用，孤立的结果不能发送给模型。
    if (message.toolResults?.length) {
      const previous = messages[index - 1];
      const ids = new Set(previous?.toolUses?.map((use) => use.id));
      if (previous?.role !== "assistant" || !message.toolResults.every((result) => ids.has(result.toolUseId))) {
        truncatedFrom = Math.max(0, index - (previous?.toolUses?.length ? 1 : 0));
        break;
      }
    }
  }
  if (truncatedFrom !== null) messages = messages.slice(0, truncatedFrom);
  return { messages, summaryCount, skippedLines, truncatedFrom, lastTimestamp };
}
//jsonl
export function listSessions(workDir: string, excludeId?: string, limit = SESSION_LIST_LIMIT): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  try {
    for (const entry of readdirSync(sessionsDir(workDir), { withFileTypes: true })) {
      const id = entry.name.replace(/\.jsonl$/, "");
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !SESSION_ID.test(id) || id === excludeId) continue;
      try {
        const records = readSessionLines(workDir, id).map(parseRecord).filter((record): record is SessionRecord => record !== null);
        const titleMessage = records.find((record) => record.type === "message" && record.message.role === "user" && !record.message.toolResults?.length && record.message.content.trim());
        const title = titleMessage?.type === "message" ? Array.from(titleMessage.message.content.replace(/\s+/g, " ").trim()).slice(0, SESSION_TITLE_MAX_CHARS).join("") : "（无标题）";
        sessions.push({ id, title, messageCount: records.filter((record) => record.type === "message").length,
          lastActive: records.length ? new Date(records[records.length - 1]!.ts) : statSync(sessionPath(workDir, id)).mtime,
          inUse: isHeldByOther(sessionLockPath(workDir, id)) });
      } catch { /* 单个文件不可读不影响其他会话。 */ }
    }
  } catch { return []; }
  return sessions.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime() || b.id.localeCompare(a.id)).slice(0, Math.max(0, limit));
}

export function cleanupExpiredSessions(workDir: string, now = new Date()): number {
  let deleted = 0;
  try {
    const dir = sessionsDir(workDir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const id = entry.name.slice(0, -6);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !SESSION_ID.test(id)) continue;
      try {
        const path = join(dir, entry.name);
        // 被另一实例占用的会话即使超期也不删：它正在被续写（F15）。
        if (now.getTime() - statSync(path).mtimeMs > SESSION_EXPIRE_MS && !isHeldByOther(sessionLockPath(workDir, id))) { unlinkSync(path); deleted++; }
      } catch { /* 清理失败不阻断启动。 */ }
    }
  } catch { /* 目录尚未创建或不可读。 */ }
  return deleted;
}
