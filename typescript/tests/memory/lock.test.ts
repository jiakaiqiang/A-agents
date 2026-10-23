import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquire, isHeldByOther, isProcessAlive, sessionLockPath, tryAcquire } from "../../src/memory/lock.js";
import { fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
let path: string;
beforeEach(() => {
  f = fixture();
  path = join(f.workDir, ".mewcode", "locks", "memory.lock");
});
afterEach(() => f.cleanup());

// 「另一个存活进程」用父进程模拟：测试进程运行期间它必然存活且 pid 不同。
const DEAD_PID = 999_999;
const other = (ts = Date.now()) => JSON.stringify({ pid: process.ppid, ts });

test("前提：父进程存活、虚构 pid 不存在", () => {
  expect(process.ppid).not.toBe(process.pid);
  expect(isProcessAlive(process.ppid)).toBe(true);
  expect(isProcessAlive(DEAD_PID)).toBe(false);
});

test("独占获取：锁文件记录本进程 pid；被存活的其他进程持有时失败", () => {
  const release = tryAcquire(path);
  expect(release).not.toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
  release!();
  f.write(path, other());
  expect(tryAcquire(path)).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.ppid);
});

test("持有进程已不存在或锁文件损坏时视为残留并回收", () => {
  for (const content of [JSON.stringify({ pid: DEAD_PID, ts: Date.now() }), "garbage", "{}"]) {
    f.write(path, content);
    const release = tryAcquire(path);
    expect(release).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    release!();
  }
});

test("超时残留只在给出 staleMs 时生效", () => {
  f.write(path, other(Date.now() - 60_000));
  expect(tryAcquire(path)).toBeNull();
  const release = tryAcquire(path, 30_000);
  expect(release).not.toBeNull();
  release!();
});

test("释放只删自己的锁，重复调用安全", () => {
  const release = tryAcquire(path)!;
  release();
  expect(existsSync(path)).toBe(false);
  expect(() => release()).not.toThrow();
  const second = tryAcquire(path)!;
  f.write(path, other()); // 模拟锁被别人回收重建
  second();
  expect(existsSync(path)).toBe(true);
});

test("acquire 在等待期内拿到释放的锁，持有者不放则按时超时", async () => {
  f.write(path, other());
  setTimeout(() => f.write(path, JSON.stringify({ pid: DEAD_PID, ts: Date.now() })), 150);
  const release = await acquire(path, 1_000);
  expect(release).not.toBeNull();
  release!();

  f.write(path, other());
  const started = Date.now();
  expect(await acquire(path, 200)).toBeNull();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(190);
  expect(elapsed).toBeLessThan(1_000);
});

test("isHeldByOther 区分无锁、自己持有、他人存活、他人已死", () => {
  expect(isHeldByOther(path)).toBe(false);
  const release = tryAcquire(path)!;
  expect(isHeldByOther(path)).toBe(false);
  release();
  f.write(path, other());
  expect(isHeldByOther(path)).toBe(true);
  f.write(path, JSON.stringify({ pid: DEAD_PID, ts: Date.now() }));
  expect(isHeldByOther(path)).toBe(false);
});

test("会话锁路径位于 .mewcode/locks/sessions/", () => {
  expect(sessionLockPath(f.workDir, "20261019-120000-abcd")).toBe(join(f.workDir, ".mewcode", "locks", "sessions", "20261019-120000-abcd.lock"));
});
