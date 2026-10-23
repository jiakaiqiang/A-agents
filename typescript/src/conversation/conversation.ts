export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  display?: string; // 仅供界面展示（如提示词命令的原命令），不发给模型
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
}

export interface HistoryRecorder {
  onAppend(message: Message): void;
  onReplace(messages: Message[]): void;
}

export class ConversationManager {
  private history: Message[] = [];
  private ltmInjected = false;
  private recorder: HistoryRecorder | null = null;

  setRecorder(recorder: HistoryRecorder | null): void {
    this.recorder = recorder;
  }

  private push(message: Message): void {
    this.history.push(message);
    this.recorder?.onAppend(message);
  }

  addUserMessage(content: string, display?: string): void {
    this.push(display !== undefined && display !== content ? { role: "user", content, display } : { role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.push({ role: "assistant", content });
  }

  addAssistantFull(content: string, thinkingBlocks?: ThinkingBlock[], toolUses?: ToolUseBlock[]): void {
    this.push({ role: "assistant", content, thinkingBlocks, toolUses });
  }

  addToolUseMessage(content: string, toolUses: ToolUseBlock[]): void {
    this.push({ role: "assistant", content, toolUses });
  }

  addAssistantMessageWithTools(content: string, toolUses: ToolUseBlock[]): void {
    this.addToolUseMessage(content, toolUses);
  }

  addToolResultMessage(toolResults: ToolResultBlock[]): void {
    this.push({ role: "user", content: "", toolResults });
  }

  addToolResultsMessage(toolResults: ToolResultBlock[]): void {
    this.addToolResultMessage(toolResults);
  }

  addSystemReminder(content: string): void {
    this.push({ role: "system", content });
  }

  injectLongTermMemory(_content: string): void {
    this.ltmInjected = true;
  }

  replaceWithCompacted(messages: Message[]): void {
    this.history = [...messages];
    this.recorder?.onReplace(this.getMessages());
  }

  /** 恢复已有记录，不把同一段历史重复写盘。 */
  restore(messages: Message[]): void {
    this.history = structuredClone(messages);
  }

  getMessages(): Message[] {
    return this.history.map((message) => ({
      ...message,
      thinkingBlocks: message.thinkingBlocks ? [...message.thinkingBlocks] : undefined,
      toolUses: message.toolUses ? [...message.toolUses] : undefined,
      toolResults: message.toolResults ? [...message.toolResults] : undefined,
    }));
  }

  len(): number {
    return this.history.length;
  }

  /** 全历史字符总数：Token 估算锚点与压缩判断共用此口径（上下文 spec F1）。 */
  chars(): number {
    let total = 0;
    for (const message of this.history) {
      total += message.content.length;
      for (const result of message.toolResults ?? []) total += result.content.length;
      for (const use of message.toolUses ?? []) total += JSON.stringify(use.arguments).length;
    }
    return total;
  }

  truncateTo(index: number): void {
    this.history = this.history.slice(0, Math.max(0, index));
  }
}
