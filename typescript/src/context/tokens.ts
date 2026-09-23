// Token 近似估算（spec F1）：不做精确 tokenizer，锚定上次 API usage、增量按字符折算。

import type { Message } from "../conversation/conversation.js";

/** 统一折算口径：约 4 字符 ≈ 1 token。 */
export const CHARS_PER_TOKEN = 4;

/** 锚点：锚定时的历史总字符数与真实 input tokens。 */
interface Anchor {
  historyChars: number;
  inputTokens: number;
}

/** 单条消息的字符口径：自然语言正文 + 工具结果 + 工具调用参数。 */
export function estimateChars(message: Message): number {
  let chars = message.content.length;
  for (const result of message.toolResults ?? []) {
    chars += result.content.length;
  }
  for (const use of message.toolUses ?? []) {
    chars += JSON.stringify(use.arguments).length;
  }
  return chars;
}

/**
 * 会话级 Token 估算器（spec F1）：
 * 锚点存在时 = 锚点值 + 历史增量字符 / 4；无锚点全量按字符 / 4。
 */
export class TokenEstimator {
  private anchor: Anchor | null = null;

  /** 每轮请求返回 usage 后调用，锚定真实值。 */
  setAnchor(historyChars: number, inputTokens: number): void {
    this.anchor = { historyChars, inputTokens };
  }

  /** 压缩后调用：丢弃旧锚点，回到纯字符估算（spec F12）。 */
  resetAnchor(): void {
    this.anchor = null;
  }

  get anchored(): boolean {
    return this.anchor !== null;
  }

  /** 全历史字符数换算成估算 tokens。 */
  estimate(totalChars: number): number {
    if (!this.anchor) {
      return Math.floor(totalChars / CHARS_PER_TOKEN);
    }
    const deltaChars = Math.max(0, totalChars - this.anchor.historyChars);
    return this.anchor.inputTokens + Math.floor(deltaChars / CHARS_PER_TOKEN);
  }

  estimateMessages(messages: Message[]): number {
    let chars = 0;
    for (const message of messages) chars += estimateChars(message);
    return this.estimate(chars);
  }

  sumChars(messages: Message[]): number {
    let chars = 0;
    for (const message of messages) chars += estimateChars(message);
    return chars;
  }
}
