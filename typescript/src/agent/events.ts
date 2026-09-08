import type { UsageInfo } from "../llm/events.js";

/** 循环停止原因，五种互斥（spec F5–F9）。 */
export type StopReason =
  | "complete" // 模型不再请求工具，本轮自然完成（F5）
  | "max_iterations" // 达到迭代上限兜底（F6）
  | "cancelled" // 用户取消（F7）
  | "invalid_tools" // 连续多次迭代全部调用未知工具（F8）
  | "stream_error"; // 模型请求或流式解析出错（F9）

/** 单次迭代内的阶段，供界面显示当前在等模型还是在跑工具。 */
export type LoopPhase = "model" | "tools";

/** 会话模式：执行模式全工具，计划模式仅只读工具。 */
export type AgentMode = "execute" | "plan";

/**
 * 编排层对外的唯一输出形态（spec F11/F12）。
 * 界面只按类型渲染，对迭代次数、批次划分、协议差异无感知。
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; toolId: string; name: string; argSummary: string }
  | { type: "tool_end"; toolId: string; ok: boolean; summary: string }
  | { type: "usage"; usage: UsageInfo } // 本轮累计值，由 loop 累加后发出
  | { type: "progress"; iteration: number; phase: LoopPhase; toolsExecuted: number }
  | { type: "notice"; text: string; isError: boolean }
  | {
    // 本轮末尾事件，同时承载停止原因与统计；生成器的 return 值在 for await 中拿不到。
    type: "done";
    reason: StopReason;
    iterations: number; // 已发起的模型请求次数
    toolsExecuted: number;
    finalText: string;
    errorMessage?: string; // reason === "stream_error" 时携带
  };
