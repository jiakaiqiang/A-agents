import { DANGEROUS_PATTERNS } from "./limits.js";
import type { LayerResult } from "./types.js";

/**
 * 第一层：危险命令黑名单（spec F4、F5）。
 * 非 Bash 工具直接不表态；命中则拒绝。本层永不返回 allow——
 * 通过黑名单不等于获得放行，后续层仍要继续判定（spec F2、N2）。
 */
export function checkBlacklist(toolName: string, args: Record<string, unknown>): LayerResult {
  if (toolName !== "Bash") return { verdict: "abstain" };

  const command = args.command;
  if (typeof command !== "string" || command.trim() === "") return { verdict: "abstain" };

  for (const item of DANGEROUS_PATTERNS) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(command)) {
      return {
        verdict: "deny",
        reason: `危险操作被拒绝（${item.label}）：该限制不可通过配置或权限档位放开。`,
      };
    }
  }
  return { verdict: "abstain" };
}
