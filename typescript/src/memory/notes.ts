import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dump, load } from "js-yaml";
import { MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES } from "../tools/limits.js";
import { resolveInside } from "../tools/paths.js";

export type NoteType = "user" | "feedback" | "project" | "reference";
export type NoteScope = "user" | "project";
export interface Note { name: string; description: string; type: NoteType; body: string }

export const NOTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  user: "用户偏好", feedback: "纠正反馈", project: "项目知识", reference: "参考资料",
};

export function isNote(value: unknown): value is Note {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Record<string, unknown>;
  return typeof note.name === "string" && NOTE_NAME_PATTERN.test(note.name)
    && typeof note.description === "string" && !!note.description.trim() && !/[\r\n]/.test(note.description)
    && typeof note.type === "string" && Object.hasOwn(NOTE_TYPE_LABELS, note.type) && typeof note.body === "string";
}

export function memoryDir(scope: NoteScope, workDir: string, homeDir = homedir()): string {
  return join(scope === "user" ? homeDir : workDir, ".mewcode", "memory");
}
// 这个是系统维护的memory
export class MemoryStore {
  constructor(readonly dir: string) {}

  private path(filename: string): string {
    const safe = resolveInside(this.dir, filename);
    if (!safe.ok) throw new Error(safe.reason);
    return safe.absolute;
  }

  private notePath(name: string): string {
    if (!NOTE_NAME_PATTERN.test(name)) throw new Error("笔记名必须为 1–64 个小写字母、数字或连字符");
    return this.path(`${name}.md`);
  }

  private atomicWrite(filename: string, text: string): void {
    const target = this.path(filename);
    mkdirSync(this.dir, { recursive: true });
    const temp = this.path(`${filename}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
      renameSync(temp, target);
    } finally {
      try { unlinkSync(temp); } catch { /* 成功重命名后临时文件已不存在。 */ }
    }
  }

  read(name: string): Note | null {
    const path = this.notePath(name);
    try {
      const text = readFileSync(path, "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
      if (!match) return null;
      const meta = load(match[1]!);
      if (typeof meta !== "object" || meta === null) return null;
      const note = { ...meta, body: match[2]!.replace(/^\r?\n/, "") };
      return isNote(note) && note.name === name ? note : null;
    } catch { return null; }
  }

  list(): Note[] {
    const notes: Note[] = [];
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
        const name = entry.name.slice(0, -3);
        if (!NOTE_NAME_PATTERN.test(name)) continue;
        const note = this.read(name);
        if (note) notes.push(note);
      }
    } catch { /* 缺失或不可读时视为空仓库。 */ }
    return notes.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  write(note: Note): void {
    if (!isNote(note)) throw new Error("笔记字段不合法");
    this.notePath(note.name);
    const { name, description, type } = note;
    this.atomicWrite(`${name}.md`, `---\n${dump({ name, description, type }, { lineWidth: -1 })}---\n\n${note.body}`);
  }

  delete(name: string): boolean {
    const path = this.notePath(name);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  rebuildIndex(): void {
    const lines = this.list().map((note) => `- ${note.description}（${note.name}.md，${NOTE_TYPE_LABELS[note.type]}）`);
    this.atomicWrite("MEMORY.md", lines.length ? lines.join("\n") + "\n" : "");
  }

  readIndex(): string {
    try { return readFileSync(this.path("MEMORY.md"), "utf8"); }
    catch { return ""; }
  }

  /** 跨进程写入互斥的锁文件：<dir 的上级>/locks/memory.lock，即 .mewcode/locks/memory.lock（F16）。 */
  get lockPath(): string {
    return join(dirname(this.dir), "locks", "memory.lock");
  }

  /**
   * 目录内容指纹（F16 乐观锁）：覆盖全部 .md 而不只是 MEMORY.md——只改正文时索引不变，只比索引会漏掉冲突。
   * 按内容而非 mtime 计算：同一毫秒内的同长度改写 mtime 可能不变，笔记体量小，读全文成本可忽略。
   */
  fingerprint(): string {
    const hash = createHash("sha1");
    try {
      const names = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
      for (const name of names) hash.update(`${name}\0`).update(readFileSync(join(this.dir, name))).update("\0");
    } catch {
      return "empty";
    }
    return hash.digest("hex");
  }
}

export function truncateIndex(text: string): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length <= MEMORY_INDEX_MAX_LINES && Buffer.byteLength(text) <= MEMORY_INDEX_MAX_BYTES) return { text, truncated: false };
  const marker = "（索引已截断）";
  const kept: string[] = [];
  let bytes = Buffer.byteLength(marker);
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (kept.length >= MEMORY_INDEX_MAX_LINES - 1 || bytes + size > MEMORY_INDEX_MAX_BYTES) break;
    kept.push(line);
    bytes += size;
  }
  return { text: [...kept, marker].join("\n"), truncated: true };
}
// 加载记忆快照
export function loadMemorySnapshot(workDir: string, homeDir = homedir()): string {
  const sections: string[] = [];
  for (const scope of ["user", "project"] as const) {
    const index = truncateIndex(new MemoryStore(memoryDir(scope, workDir, homeDir)).readIndex()).text;
    if (index.trim()) sections.push(`## ${scope === "user" ? "用户级记忆" : "项目级记忆"}\n${index}`);
  }
  return sections.length ? `# 记忆\n以下是你在以往会话中积累的记忆，处理请求时直接参考；与用户当前明确指示冲突时以用户为准。\n\n${sections.join("\n\n")}` : "";
}
