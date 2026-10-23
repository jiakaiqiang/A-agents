import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadMemorySnapshot, memoryDir, MemoryStore, truncateIndex, type Note } from "../../src/memory/notes.js";
import { fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());
const note: Note = { name: "prefers-chinese", type: "user", description: "用户偏好中文回复", body: "细节\n" };

test("笔记往返与索引一致，特殊 YAML 字符保留且不残留临时文件", () => {
  const store = new MemoryStore(memoryDir("project", f.workDir, f.homeDir));
  store.write({ ...note, description: '偏好: 中文 # 注释 "yes"' });
  store.write({ ...note, name: "project-rule", type: "project" });
  store.rebuildIndex();
  expect(store.read(note.name)).toEqual({ ...note, description: '偏好: 中文 # 注释 "yes"' });
  expect(store.list()).toHaveLength(2);
  expect(store.readIndex().trim().split("\n")).toHaveLength(2);
  expect(store.readIndex()).toContain("prefers-chinese.md，用户偏好");
  expect(readdirSync(store.dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  expect(store.delete(note.name)).toBe(true);
  expect(store.delete(note.name)).toBe(false);
  store.rebuildIndex();
  expect(store.readIndex()).not.toContain("prefers-chinese.md");
});

test("非法笔记名、类型和多行描述被拒绝，损坏 frontmatter 被跳过", () => {
  const store = new MemoryStore(memoryDir("project", f.workDir, f.homeDir));
  for (const name of ["../x", "A B", "-bad", "x".repeat(65)]) expect(() => store.write({ ...note, name })).toThrow();
  expect(() => store.write({ ...note, description: "a\nb" })).toThrow();
  store.write(note);
  f.write(join(store.dir, "broken.md"), "---\nname: [\n---\nBODY");
  f.write(join(store.dir, "wrong.md"), "---\nname: wrong\ntype: constructor\ndescription: nope\n---\nBODY");
  expect(store.list()).toEqual([note]);
});

test("符号链接不能把笔记写到仓库外，写失败不留临时文件", () => {
  const store = new MemoryStore(memoryDir("project", f.workDir, f.homeDir));
  store.write(note);
  f.write(join(f.homeDir, "target.md"), "ORIGINAL");
  // 目录联接无需 Windows 创建文件符号链接的额外权限。
  symlinkSync(f.homeDir, join(store.dir, "escape.md"), "junction");
  expect(() => store.write({ ...note, name: "escape" })).toThrow();
  expect(readdirSync(store.dir).some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("索引截断包含提示，最终行数与 UTF-8 字节均不超限", () => {
  const lines = truncateIndex(Array.from({ length: 250 }, (_, i) => `- fact${i}`).join("\n"));
  expect(lines.truncated).toBe(true);
  expect(lines.text.split("\n")).toHaveLength(200);
  expect(lines.text).toContain("已截断");
  const bytes = truncateIndex(Array(100).fill("中".repeat(300)).join("\n"));
  expect(Buffer.byteLength(bytes.text)).toBeLessThanOrEqual(25_000);
  expect(bytes.text).toContain("已截断");
  expect(truncateIndex("中".repeat(30_000)).text).toBe("（索引已截断）");
  expect(truncateIndex("hello\n")).toEqual({ text: "hello\n", truncated: false });
});

test("记忆快照分范围，空范围省略且快照保持不变", () => {
  expect(loadMemorySnapshot(f.workDir, f.homeDir)).toBe("");
  const user = new MemoryStore(memoryDir("user", f.workDir, f.homeDir));
  const project = new MemoryStore(memoryDir("project", f.workDir, f.homeDir));
  user.write(note); user.rebuildIndex();
  const snapshot = loadMemorySnapshot(f.workDir, f.homeDir);
  expect(snapshot).toContain("## 用户级记忆");
  expect(snapshot).not.toContain("## 项目级记忆");
  project.write({ ...note, name: "project-stack", type: "project" }); project.rebuildIndex();
  expect(loadMemorySnapshot(f.workDir, f.homeDir)).toContain("## 项目级记忆");
  expect(snapshot).not.toContain("project-stack");
});

test("目录指纹：无变化相同；新增、删除、只改正文都变化；锁路径位于 .mewcode/locks/", () => {
  const user = new MemoryStore(memoryDir("user", f.workDir, f.homeDir));
  const project = new MemoryStore(memoryDir("project", f.workDir, f.homeDir));
  expect(user.fingerprint()).toBe("empty");
  expect(user.lockPath).toBe(join(f.homeDir, ".mewcode", "locks", "memory.lock"));
  expect(project.lockPath).toBe(join(f.workDir, ".mewcode", "locks", "memory.lock"));

  user.write(note); user.rebuildIndex();
  const base = user.fingerprint();
  expect(user.fingerprint()).toBe(base);
  user.write({ ...note, body: "只改正文\n" });
  const bodyChanged = user.fingerprint();
  expect(user.readIndex()).toContain(note.description); // 索引不变，指纹仍要变化
  expect(bodyChanged).not.toBe(base);
  user.write({ ...note, name: "another-note" });
  const added = user.fingerprint();
  expect(added).not.toBe(bodyChanged);
  user.delete("another-note");
  expect(user.fingerprint()).not.toBe(added);
  expect(user.fingerprint()).toBe(bodyChanged);
});
