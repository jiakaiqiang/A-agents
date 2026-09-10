// 权限系统的常量唯一声明处（spec N8、AC27）：黑名单模式、档位名、档位兜底表、工具分类。
// 其他文件只引用这里，不重复声明。
// 不放进 src/tools/limits.ts：后者专收资源上限，混入黑名单正则会削弱它的定位。

import type { Tool } from "../tools/types.js";
import type { PermissionMode, ToolClass } from "./types.js";

/**
 * 危险命令黑名单（spec F4、F5）：命中即拒，不可被任何配置、档位或规则放开。
 * 可变空白统一用 \s+，避免 `rm  -rf  /` 这类多空格写法绕过。
 */
export const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // 根目录递归删除：rm -rf /、rm -fr /*、带 --no-preserve-root 的变体。
  { pattern: /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:-\S+\s+)*\/(?:\s|$|\*)/i, label: "根目录递归删除" },
  { pattern: /\brm\s+[^\n]*--no-preserve-root/i, label: "解除根目录保护的删除" },
  // Windows 侧的等价操作：格式化盘符、递归删除盘根。
  { pattern: /\b(?:rd|rmdir)\s+(?:\/\S+\s+)*[a-zA-Z]:\\?(?:\s|$)/i, label: "盘根递归删除" },
  { pattern: /\bdel\s+(?:\/\S+\s+)*[a-zA-Z]:\\(?:\s|$|\*)/i, label: "盘根批量删除" },

  // 裸设备写入：绕过文件系统直接覆盖磁盘。
  { pattern: /\bdd\s+[^\n]*\bof\s*=\s*(?:\/dev\/|\\\\\.\\)/i, label: "裸设备写入" },
  { pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|disk\d)/i, label: "裸设备重定向写入" },

  // 文件系统格式化与分区表操作。
  { pattern: /\bmkfs(?:\.\w+)?\s/i, label: "文件系统格式化" },
  { pattern: /\bformat\s+[a-zA-Z]:/i, label: "磁盘格式化" },
  { pattern: /\b(?:fdisk|parted|diskpart)\b/i, label: "磁盘分区表操作" },

  // 下载后直接执行：内容不可审计。
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i, label: "下载内容直接执行" },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:python|perl|ruby|node)\b/i, label: "下载内容直接执行" },
  { pattern: /\biex\b[^\n]*\b(?:iwr|invoke-webrequest|downloadstring)\b/i, label: "下载内容直接执行" },

  // 权限递归放开：把系统目录改成任意可写。
  { pattern: /\bchmod\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:-\S+\s+)*777\s+\//i, label: "根目录权限递归放开" },
  { pattern: /\bchmod\s+(?:-\S+\s+)*777\s+\/(?:\s|$)/i, label: "根目录权限放开" },
  { pattern: /\bchown\s+(?:-\S+\s+)*-\S*[rR]\S*\s+[^\n]*\s\/(?:\s|$)/i, label: "根目录属主递归变更" },

  // fork 炸弹与整机关停。
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;?\s*:/, label: "fork 炸弹" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, label: "系统关机或重启" },
  { pattern: /\bmkswap\b|\bswapoff\s+-a\b/i, label: "交换区操作" },

  // 覆盖引导扇区。
  { pattern: /\bdd\s+[^\n]*\bif\s*=\s*\/dev\/(?:zero|random|urandom)[^\n]*\bof\s*=/i, label: "磁盘擦除" },
];

/** 四档全量（spec F14）。顺序即 Shift+Tab 的循环顺序：计划 → 默认 → acceptEdits → 放行。 */
export const PERMISSION_MODES: PermissionMode[] = ["plan", "default", "acceptEdits", "bypass"];

/** 按循环顺序取下一档，末档绕回第一档。 */
export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const index = PERMISSION_MODES.indexOf(current);
  const from = index < 0 ? 0 : index;
  return PERMISSION_MODES[(from + 1) % PERMISSION_MODES.length]!;
}

/**
 * 档位兜底表（spec F14 那张表的数据化形式）。
 * 只有 allow 与 ask 两种取值——四档中没有任何一档的兜底是直接拒绝。
 * 兜底只在规则未命中时生效，命中的规则不受档位影响（spec F15）。
 */
export const MODE_FALLBACK: Record<PermissionMode, Record<ToolClass, "allow" | "ask">> = {
  plan: { read: "allow", write: "ask", bash: "ask" },
  default: { read: "allow", write: "ask", bash: "ask" },
  acceptEdits: { read: "allow", write: "allow", bash: "ask" },
  bypass: { read: "allow", write: "allow", bash: "allow" },
};

/** 工具分类（spec F14）：只读归 read，Bash 单列，其余算写类。 */
export function classifyTool(tool: Tool): ToolClass {
  if (tool.readOnly) return "read";
  if (tool.name === "Bash") return "bash";
  return "write";
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as string[]).includes(value);
}

/** 各工具承载路径的参数字段名，供沙箱层与规则层取值（spec F6、F9）。 */
export const PATH_ARG_BY_TOOL: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "path",
  Grep: "path",
};
