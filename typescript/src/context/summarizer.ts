// 第二层兜底的摘要生成（spec F8–F10）：Prompt 禁工具、先草稿后正式、九段结构。

import type { Message } from "../conversation/conversation.js";
import { ConversationManager } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import type { UsageInfo } from "../llm/events.js";
import { emptyUsage } from "../llm/events.js";

/** 摘要请求的截短口径：从尾部保留 5 轮原始对话（spec F10）。 */
export const SUMMARY_KEEP_TURNS = 5;

const SUMMARY_SYSTEM = [
  "你是对话摘要生成器，负责把较早的对话历史压缩成结构化摘要。",
  "",
  "硬规则：",
  "1. 禁止调用任何工具——本次请求没有提供任何工具，你只能输出文本。",
  "2. 先写一份分析草稿（读一遍对话、梳理脉络），再写正式摘要。",
  "3. 草稿用完即弃：正式输出里只包含最终摘要，草稿内容不得出现在任何持久化输出中。",
].join("\n");

const SUMMARY_SECTIONS = [
  "1. 主要请求和意图",
  "2. 关键技术概念",
  "3. 文件和代码段",
  "4. 错误和修复",
  "5. 问题解决过程",
  "6. 所有用户消息",
  "7. 待办任务",
  "8. 当前工作",
  "9. 可能的下一步",
].join("\n");

/** 待摘要消息转储为纯文本，标注角色。 */
function dumpHistory(history: Message[]): string {
  const lines: string[] = [];
  for (const message of history) {
    const role = message.role === "assistant" ? "助手" : message.role === "system" ? "系统" : "用户";
    if (message.content) lines.push(`【${role}】${message.content}`);
    for (const use of message.toolUses ?? []) {
      lines.push(`【${role}·工具调用】${use.name} ${JSON.stringify(use.arguments)}`);
    }
    for (const result of message.toolResults ?? []) {
      lines.push(`【工具结果】${result.content}`);
    }
  }
  return lines.join("\n");
}

export function buildSummaryPrompt(history: Message[]): { system: string; user: string } {
  const user = [
    "请按以下九个固定部分组织摘要（缺内容的部分写「无」）：",
    "",
    SUMMARY_SECTIONS,
    "",
    "──待摘要的对话如下──",
    dumpHistory(history),
  ].join("\n");
  return { system: SUMMARY_SYSTEM, user };
}

/**
 * 请求副本截短（spec F10）：从尾部保留 5 轮原始对话，
 * 更早部分替换为一行占位；不改原数组。
 */
export function truncateForSummary(history: Message[]): Message[] {
  if (history.length <= SUMMARY_KEEP_TURNS * 2) return [...history];
  const kept = history.slice(-SUMMARY_KEEP_TURNS * 2);
  return [{ role: "user", content: "[更早的对话已省略]" }, ...kept];
}

/**
 * 调 LLM 生成摘要：复用 stream() 但传空工具列表——模型物理上无工具可调（spec F9）。
 * 待摘要区超窗风险由调用方先做总量判断，这里只保证请求副本不超（F10 截短）。
 */
export async function generateSummary(
  client: LLMClient,
  history: Message[],
  estimateTokens: (messages: Message[]) => number,
  tokenBudget: number,
  signal?: AbortSignal,
): Promise<{ summary: string; usage: UsageInfo }> {
  let requestHistory = history;
  if (estimateTokens(requestHistory) > tokenBudget) {
    requestHistory = truncateForSummary(requestHistory);
  }

  const conversation = new ConversationManager();
  const { system, user } = buildSummaryPrompt(requestHistory);
  conversation.addUserMessage(user);

  let summary = "";
  const usage = emptyUsage();
  for await (const event of client.stream(conversation, [], { signal, reminders: [system] })) {
    if (event.type === "text_delta") summary += event.text;
    if (event.type === "stream_end") {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
      usage.cacheCreationInputTokens += event.usage.cacheCreationInputTokens;
    }
  }
  return { summary: summary.trim(), usage };
}
