// 两层压缩编排（spec F6–F15）：分界计算、轻量预防、摘要替换、熔断状态机。

import type { ConversationManager, Message, ToolResultBlock } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import { generateSummary } from "./summarizer.js";
import { buildPreview, maybeSpillResult, MESSAGE_SPILL_TOKENS, spillToFile, TOOL_SPILL_TOKENS } from "./spill.js";
import { estimateChars, CHARS_PER_TOKEN, TokenEstimator } from "./tokens.js";
import type { ContextManagementConfig } from "../config/config.js";

export const AUTO_MARGIN_TOKENS = 13_000; // 自动触发安全余量（F6）
export const MANUAL_MARGIN_TOKENS = 3_000; // 手动压后校验余量（F13）
export const KEEP_RECENT_TOKENS = 10_000; // 近期原文区 token 线（F7）
export const KEEP_RECENT_NATURAL = 5; // 近期自然语言消息条数线（F7）
export const MAX_SUMMARY_FAILURES = 3; // 熔断阈值（F14）

export interface CompactionSettings {
  autoMarginTokens: number;
  manualMarginTokens: number;
  keepRecentTokens: number;
  keepRecentNatural: number;
  maxSummaryFailures: number;
  toolSpillTokens: number;
  messageSpillTokens: number;
  spillPreviewChars: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  autoMarginTokens: AUTO_MARGIN_TOKENS,
  manualMarginTokens: MANUAL_MARGIN_TOKENS,
  keepRecentTokens: KEEP_RECENT_TOKENS,
  keepRecentNatural: KEEP_RECENT_NATURAL,
  maxSummaryFailures: MAX_SUMMARY_FAILURES,
  toolSpillTokens: TOOL_SPILL_TOKENS,
  messageSpillTokens: MESSAGE_SPILL_TOKENS,
  spillPreviewChars: 500,
};

export function resolveCompactionSettings(config?: ContextManagementConfig): CompactionSettings {
  return {
    autoMarginTokens: config?.auto_margin_tokens ?? DEFAULT_COMPACTION_SETTINGS.autoMarginTokens,
    manualMarginTokens: config?.manual_margin_tokens ?? DEFAULT_COMPACTION_SETTINGS.manualMarginTokens,
    keepRecentTokens: config?.keep_recent_tokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    keepRecentNatural: config?.keep_recent_natural ?? DEFAULT_COMPACTION_SETTINGS.keepRecentNatural,
    maxSummaryFailures: config?.max_summary_failures ?? DEFAULT_COMPACTION_SETTINGS.maxSummaryFailures,
    toolSpillTokens: config?.tool_spill_tokens ?? DEFAULT_COMPACTION_SETTINGS.toolSpillTokens,
    messageSpillTokens: config?.message_spill_tokens ?? DEFAULT_COMPACTION_SETTINGS.messageSpillTokens,
    spillPreviewChars: config?.spill_preview_chars ?? DEFAULT_COMPACTION_SETTINGS.spillPreviewChars,
  };
}

export const SUMMARY_PREFIX = "【历史摘要】";
export const BOUNDARY_TEXT = "以上是对较早对话的结构化摘要。摘要可能丢失文件内容细节：需要文件的具体内容时，请用 Read 重新读取原文件，不要根据摘要臆测代码。";

export interface CompactionResult {
  compacted: boolean;
  /** 被摘要掉的消息条数。 */
  summaryMessageCount: number;
  /** 近期原文保留条数。 */
  recentCount: number;
  /** 失败原因；熔断计数已加一。 */
  error?: string;
  /** 熔断是否因此打开。 */
  circuitOpen?: boolean;
  summary?: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface HistorySplit {
  toSummarize: Message[];
  recent: Message[];
}

/** 单条工具结果块的 token 估算（纯字符口径，不依赖锚点）。 */
function blockTokens(block: ToolResultBlock): number {
  return Math.ceil(block.content.length / CHARS_PER_TOKEN);
}

/**
 * 分界计算（spec F7）：从尾向前累计，10K tokens 或 5 条自然语言消息先到为准。
 * 自然语言 = user 且无 toolResults，或 assistant 且有正文；工具结果消息不占名额但 token 照算。
 */
export function splitHistory(messages: Message[], settings = DEFAULT_COMPACTION_SETTINGS): HistorySplit {
  let tokens = 0;
  let natural = 0;
  let index = messages.length;
  while (index > 0) {
    const message = messages[index - 1]!;
    const isNatural =
      (message.role === "user" && !message.toolResults?.length) ||
      (message.role === "assistant" && message.content.length > 0);
    tokens += Math.ceil(estimateChars(message) / CHARS_PER_TOKEN);
    if (isNatural) natural += 1;
    index -= 1;
    // 这条已收进近期区，再判断是否达标：两条线先到即停。
    if (tokens >= settings.keepRecentTokens || natural >= settings.keepRecentNatural) break;
  }
  // 近期区不能从孤立工具结果开始，否则持久化后无法按协议恢复。
  if (index > 0 && messages[index]?.toolResults?.length && messages[index - 1]?.toolUses?.length) index--;
  return { toSummarize: messages.slice(0, index), recent: messages.slice(index) };
}

export class Compactor {
  private failures = 0;

  constructor(
    private readonly client: LLMClient,
    private readonly conversation: ConversationManager,
    readonly estimator: TokenEstimator,
    private readonly workDir: string,
    private readonly contextWindow: number,
    settings?: CompactionSettings,
  ) { this.settings = settings ?? DEFAULT_COMPACTION_SETTINGS; }

  private readonly settings: CompactionSettings;

  get circuitOpen(): boolean {
    return this.failures >= this.settings.maxSummaryFailures;
  }

  get failureCount(): number {
    return this.failures;
  }

  /** 每轮请求返回 usage 后由 loop 调用，锚定真实值（spec F1）。 */
  noteUsage(historyChars: number, inputTokens: number): void {
    this.estimator.setAnchor(historyChars, inputTokens);
  }

  /** 压缩后剩余空间（供 /compact 压后校验）。 */
  remainingTokens(): number {
    return this.contextWindow - this.estimator.estimate(this.conversation.chars());
  }

  resetFailures(): void {
    this.failures = 0;
  }

  /** 估算整段消息的 tokens（供摘要截短判断）。 */
  estimateMessages(messages: Message[]): number {
    return this.estimator.estimateMessages(messages);
  }

  /**
   * 轻量预防（spec F2/F3）：结果写入历史前调用。
   * 先按单条 2K 判定，再按组合计 8K 从最大者开始依次存盘。
   */
  async applyLightPrevention(blocks: ToolResultBlock[], toolNames: ReadonlyMap<string, string> = new Map()): Promise<ToolResultBlock[]> {
    const processed = [...blocks];
    const nameFor = (block: ToolResultBlock, index: number): string => toolNames.get(block.toolUseId) ?? `tool-${index}`;
    // 已存盘的下标不再重复存盘：预览文本本身不会再超阈值，但显式记录更直观。
    const spilled = new Set<number>();
    for (const [index, block] of processed.entries()) {
      const outcome = await maybeSpillResult(
        nameFor(block, index),
        { ok: !block.isError, content: block.content, summary: "" },
        this.workDir,
        this.estimator,
        this.settings.toolSpillTokens,
        this.settings.spillPreviewChars,
      );
      if (outcome.spilled) {
        processed[index] = { ...block, content: outcome.content };
        spilled.add(index);
      }
    }

    // 合计判定（F3）：超 8K 从最大的开始依次存盘，直到回到阈值以内。
    while (this.blocksTokens(processed) > this.settings.messageSpillTokens) {
      let maxIndex = -1;
      let maxValue = -1;
      for (const [index, block] of processed.entries()) {
        if (spilled.has(index)) continue; // 已存盘的不再重复处理
        const value = blockTokens(block);
        if (value > maxValue) {
          maxValue = value;
          maxIndex = index;
        }
      }
      if (maxIndex < 0) break; // 全部已存盘仍超阈值：交由第二层兜底
      const block = processed[maxIndex]!;
      const filePath = spillToFile(nameFor(block, maxIndex), block.content, this.workDir);
      if (!filePath) break; // 存盘失败：放弃合计压缩，避免死循环
      processed[maxIndex] = { ...block, content: buildPreview(block.content, filePath, this.settings.spillPreviewChars) };
      spilled.add(maxIndex);
    }
    return processed;
  }

  private blocksTokens(blocks: ToolResultBlock[]): number {
    return blocks.reduce((sum, block) => sum + blockTokens(block), 0);
  }

  /** 每次请求前调用（spec F6）：熔断开 → 直接返回；超线 → 压缩。返回提示文本。 */
  async maintain(signal?: AbortSignal): Promise<string | null> {
    if (this.circuitOpen) return null;
    if (!this.needsCompaction()) return null;
    const result = await this.runCompaction(signal);
    if (result.compacted) return this.successNotice(result);
    if (result.circuitOpen) return "压缩连续失败，已暂停自动压缩；可用 /compact 手动重试。";
    return null;
  }

  /** 恢复会话时也使用同一条自动压缩线，不受熔断状态影响。 */
  needsCompaction(): boolean {
    return this.estimator.estimate(this.conversation.chars()) > this.contextWindow - this.settings.autoMarginTokens;
  }

  /** /compact 入口（spec F13）：无阈值直接压。 */
  async compactManually(signal?: AbortSignal): Promise<CompactionResult> {
    const result = await this.runCompaction(signal);
    if (result.compacted) this.resetFailures();
    return result;
  }

  private successNotice(result: CompactionResult): string {
    return `${this.compactionNotice(result)}\n摘要内容：\n${result.summary ?? "（摘要内容为空）"}`;
  }

  private compactionNotice(result: CompactionResult): string {
    const before = result.beforeTokens === undefined ? "?" : `约 ${result.beforeTokens}`;
    const after = result.afterTokens === undefined ? "?" : `约 ${result.afterTokens}`;
    return `上下文已从${before} tokens 压缩到${after} tokens；已压缩历史：${result.summaryMessageCount} 条消息 → 摘要 + 近期 ${result.recentCount} 条原文`;
  }

  private async runCompaction(signal?: AbortSignal): Promise<CompactionResult> {
    const history = this.conversation.getMessages();
    if (history.length === 0 || signal?.aborted) {
      return { compacted: false, summaryMessageCount: 0, recentCount: 0 };
    }

    try {
      const beforeTokens = this.estimator.estimate(this.conversation.chars());
      const split = splitHistory(history, this.settings);
      // 极端情况：近期区吞掉全部历史。此时对除最后一条外的全部消息摘要。
      let fallbackIndex = history.length - 1;
      if (fallbackIndex > 0 && history[fallbackIndex]?.toolResults?.length && history[fallbackIndex - 1]?.toolUses?.length) fallbackIndex--;
      const toSummarize = split.toSummarize.length > 0 ? split.toSummarize : history.slice(0, fallbackIndex);
      const recent = split.toSummarize.length > 0 ? split.recent : history.slice(fallbackIndex);
      if (toSummarize.length === 0) {
        return { compacted: false, summaryMessageCount: 0, recentCount: recent.length };
      }

      const { summary } = await generateSummary(
        this.client,
        toSummarize,
        (messages) => this.estimateMessages(messages),
        this.contextWindow - this.settings.autoMarginTokens,
        signal,
      );
      if (signal?.aborted) {
        return { compacted: false, summaryMessageCount: toSummarize.length, recentCount: recent.length };
      }
      if (!summary) {
        return this.recordFailure("摘要为空", toSummarize.length, recent.length);
      }

      const summaryMessage: Message = { role: "user", content: `${SUMMARY_PREFIX}\n${summary}` };
      const boundaryMessage: Message = { role: "user", content: BOUNDARY_TEXT };
      this.conversation.replaceWithCompacted([summaryMessage, ...recent, boundaryMessage]);
      this.estimator.resetAnchor(); // spec F12
      this.failures = 0;
      const afterTokens = this.estimator.estimate(this.conversation.chars());
      return { compacted: true, summaryMessageCount: toSummarize.length, recentCount: recent.length, summary, beforeTokens, afterTokens };
    } catch (error) {
      if (signal?.aborted) {
        return { compacted: false, summaryMessageCount: 0, recentCount: 0 };
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.recordFailure(message, 0, 0);
    }
  }

  private recordFailure(error: string, summarized: number, recent: number): CompactionResult {
    this.failures += 1;
    return {
      compacted: false,
      summaryMessageCount: summarized,
      recentCount: recent,
      error,
      circuitOpen: this.circuitOpen,
    };
  }
}

export { TOOL_SPILL_TOKENS, MESSAGE_SPILL_TOKENS };
