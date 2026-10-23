// 跨进程锁原语（memory spec F15–F17）：Node/Bun 没有 flock，用 wx 独占创建锁文件——
// 文件已存在即 EEXIST，由内核保证只有一个进程创建成功；锁文件记 pid，持有进程崩溃后可识别为残留。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOCK_RETRY_INTERVAL_MS } from "../tools/limits.js";

export interface LockRecord {
  pid: number;
  ts: number; // 获取时间（毫秒时间戳）
}

export type Release = () => void;

export function sessionLockPath(workDir: string, id: string): string {
  return join(workDir, ".mewcode", "locks", "sessions", `${id}.lock`);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在只是无权发信号；其余（ESRCH）视为不存在。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(path: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { pid, ts } = value as Record<string, unknown>;
    return Number.isInteger(pid) && typeof ts === "number" ? { pid: pid as number, ts } : null;
  } catch {
    return null;
  }
}

/** 记录缺失或损坏、持有进程已不存在、或超过 staleMs 都视为残留。 */
function isStale(record: LockRecord | null, staleMs?: number): boolean {
  if (!record || !isProcessAlive(record.pid)) return true;
  return staleMs !== undefined && Date.now() - record.ts > staleMs;
}

function create(path: string): boolean {
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now() }), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaser(path: string): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // 只删自己的锁：残留被别人回收并重建后，旧持有者的释放不能把新锁删掉。
      if (readRecord(path)?.pid === process.pid) unlinkSync(path);
    } catch {
      // 锁文件已不存在或不可删时无需处理。
    }
  };
}

/** 抢一次：成功返回释放函数，被存活进程持有返回 null。staleMs 缺省表示只按进程存活判断。 */
export function tryAcquire(path: string, staleMs?: number): Release | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return null;
  }
  if (create(path)) return releaser(path);
  if (!isStale(readRecord(path), staleMs)) return null;
  try {
    unlinkSync(path);
  } catch {
    // 别的进程可能同时在回收，交给下面的 wx 决胜负。
  }
  // 只再抢一次：两个进程同时回收时其中一个会失败，避免互删死循环。
  return create(path) ? releaser(path) : null;
}

/** 在 waitMs 内反复 tryAcquire，超时返回 null。 */
export async function acquire(path: string, waitMs: number, staleMs?: number): Promise<Release | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryAcquire(path, staleMs);
    if (release) return release;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
  }
}

/** 锁文件存在、不是本进程持有、且持有者仍有效。 */
export function isHeldByOther(path: string, staleMs?: number): boolean {
  const record = readRecord(path);
  if (!record) return false;
  if (record.pid === process.pid) return false;
  return !isStale(record, staleMs);
}
