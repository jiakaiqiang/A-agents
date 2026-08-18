import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ResolvedPath =
  | { ok: true; absolute: string; display: string }
  | { ok: false; reason: string };

/** 对模型呈现的路径统一为 POSIX 风格（spec N6）。 */
export function toPosix(value: string): string {
  return value.split(sep).join("/");
}

// 从目标向上找到最近的已存在祖先做 realpath，再拼回缺失段：
// 既能穿透符号链接判断真实位置，又能处理"目标文件尚未创建"的写入场景。
function realpathAllowingMissing(target: string): string {
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return target;
    missing.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // 无权限读取真实路径时退回原路径，后续 relative 判定仍然生效。
  }
  return missing.length > 0 ? join(real, ...missing) : real;
}

/**
 * 把模型给的路径解析为工作目录内的绝对路径，越界一律拒绝（spec F11）。
 * 绝对路径、`..` 上跳、符号链接逃逸都会被判定为越界。
 */
export function resolveInside(workDir: string, input: unknown): ResolvedPath {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, reason: "路径不能为空" };
  }

  let realWorkDir = resolve(workDir);
  try {
    realWorkDir = realpathSync(realWorkDir);
  } catch {
    // 工作目录不可 realpath 时使用 resolve 结果，仍可做前缀判定。
  }

  const absolute = realpathAllowingMissing(resolve(realWorkDir, input));
  const rel = relative(realWorkDir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: `路径超出工作目录，已拒绝访问：${toPosix(input)}` };
  }

  // rel 为空串表示目标就是工作目录本身，对目录类工具（Glob/Grep）是合法输入。
  return { ok: true, absolute, display: rel === "" ? "." : toPosix(rel) };
}
