// 双进程并发验收（memory checklist「并发保护」与场景 6 的替代验证）：
// 本机无 tmux，改用两个真实 Bun 进程同时操作同一项目目录，验证跨进程的会话独占与记忆写入互斥。
// 用法：bun run scripts/verify-memory-concurrency.ts（全部数据在临时目录，结束后删除）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMClient } from "../src/llm/client.js";
import { emptyUsage } from "../src/llm/events.js";
import { isHeldByOther, sessionLockPath, tryAcquire } from "../src/memory/lock.js";
import { MemoryStore, memoryDir } from "../src/memory/notes.js";
import { cleanupExpiredSessions, listSessions, sessionsDir } from "../src/memory/session.js";
import { MemoryUpdater } from "../src/memory/updater.js";

const [, , role, root = "", name = ""] = process.argv;
const paths = (base: string) => ({ workDir: join(base, "project"), homeDir: join(base, "home") });
const stores = (base: string) => {
  const { workDir, homeDir } = paths(base);
  return { user: new MemoryStore(memoryDir("user", workDir, homeDir)), project: new MemoryStore(memoryDir("project", workDir, homeDir)) };
};

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`超时：${label}`);
    await Bun.sleep(10);
  }
}

// ── 子进程角色 ──
if (role === "hold-session") {
  const release = tryAcquire(sessionLockPath(paths(root).workDir, name));
  if (!release) process.exit(2);
  writeFileSync(join(root, "held"), String(process.pid));
  setInterval(() => undefined, 1_000); // 持有直到被强杀，不走任何退出清理
} else if (role === "write-memory") {
  let calls = 0;
  const client: LLMClient = { async *stream() {
    calls++;
    if (calls === 1) writeFileSync(join(root, `ready-${name}`), "");
    // 两个进程都在拿到初始指纹后卡在这里，协调者放行后几乎同时返回、争抢写锁。
    await waitFor(() => existsSync(join(root, "go")), "放行信号");
    await Bun.sleep(Math.random() * 20);
    yield { type: "text_delta", text: JSON.stringify({ operations: [{ op: "upsert", scope: "project", name, description: `${name} 的项目知识`, type: "project", body: name }] }) };
    yield { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() };
  } };
  const updater = new MemoryUpdater(client, stores(root));
  updater.enqueue({ userText: name, assistantTexts: [], toolNames: [] });
  await updater.idle();
  console.log(JSON.stringify({ name, calls }));
  process.exit(0);
} else {
  await coordinate();
}

// ── 协调者 ──
function spawn(...args: string[]) {
  return Bun.spawn([process.execPath, import.meta.path, ...args], { stdout: "pipe", stderr: "pipe" });
}

async function verifySessionLock(base: string): Promise<void> {
  const { workDir } = paths(base);
  const id = "20260901-000000-0a0a";
  const sessionFile = join(sessionsDir(workDir), `${id}.jsonl`);
  mkdirSync(sessionsDir(workDir), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ type: "message", ts: "2026-09-01T00:00:00.000Z", message: { role: "user", content: "held" } }) + "\n");
  const old = new Date(Date.now() - 31 * 86_400_000);
  utimesSync(sessionFile, old, old);

  const holder = spawn("hold-session", base, id);
  await waitFor(() => existsSync(join(base, "held")), "子进程 A 占用会话");
  const lock = sessionLockPath(workDir, id);
  assert.equal(isHeldByOther(lock), true);
  assert.equal(tryAcquire(lock), null);
  assert.equal(listSessions(workDir)[0]!.inUse, true);
  assert.equal(cleanupExpiredSessions(workDir), 0);
  assert(existsSync(sessionFile), "被占用的超期会话不能被清理");
  console.log("✓ 会话独占：A 存活时 B 抢锁失败、列表标注使用中、超期不清理");

  holder.kill(9);
  await holder.exited;
  assert(existsSync(lock), "强杀不走清理，锁文件应残留");
  assert.equal(isHeldByOther(lock), false);
  assert.equal(listSessions(workDir)[0]!.inUse, false);
  const release = tryAcquire(lock);
  assert(release, "残留锁应可回收");
  release();
  console.log("✓ 残留回收：A 被强杀后锁文件残留，B 识别为残留并成功占用");
}

async function verifyMemoryRace(base: string, round: number): Promise<void> {
  const names = [`note-a${round}`, `note-b${round}`];
  const workers = names.map((n) => spawn("write-memory", base, n));
  await waitFor(() => names.every((n) => existsSync(join(base, `ready-${n}`))), "两个进程都已取得初始指纹");
  writeFileSync(join(base, "go"), "");
  const results = await Promise.all(workers.map(async (worker) => {
    const [code, out, err] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    assert.equal(code, 0, err);
    return JSON.parse(out.trim()) as { name: string; calls: number };
  }));

  const project = stores(base).project;
  for (const n of names) assert.equal(project.read(n)?.body, n, `${n} 应已写入`);
  const index = project.readIndex().trim().split("\n");
  assert.equal(index.length, 2);
  for (const n of names) assert(index.some((line) => line.includes(`${n}.md`)), `索引应含 ${n}`);
  assert.deepEqual(readdirSync(project.dir).filter((file) => file.endsWith(".tmp")), []);
  assert(!existsSync(project.lockPath), "写完后记忆锁应已释放");
  // 两个进程都基于同一初始指纹：先写入者 1 次请求，后写入者发现冲突重跑，共 2 次。
  assert.deepEqual(results.map((result) => result.calls).sort(), [1, 2]);
  console.log(`✓ 记忆并发第 ${round} 轮：两进程同时写入，一方冲突后重跑；两条笔记都在、索引一致、无 .tmp、锁已释放`);
}

async function coordinate(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "mewcode-concurrency-"));
  try {
    mkdirSync(paths(base).workDir, { recursive: true });
    mkdirSync(paths(base).homeDir, { recursive: true });
    await verifySessionLock(base);
    for (let round = 1; round <= 3; round++) {
      const roundBase = join(base, `round-${round}`);
      mkdirSync(paths(roundBase).workDir, { recursive: true });
      mkdirSync(paths(roundBase).homeDir, { recursive: true });
      await verifyMemoryRace(roundBase, round);
    }
    console.log("MEMORY_CONCURRENCY_OK");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
