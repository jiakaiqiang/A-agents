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
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
}

export class ConversationManager {
  private history: Message[] = [];
  private ltmInjected = false;

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.history.push({ role: "assistant", content });
  }

  addAssistantFull(content: string, thinkingBlocks?: ThinkingBlock[], toolUses?: ToolUseBlock[]): void {
    this.history.push({ role: "assistant", content, thinkingBlocks, toolUses });
  }

  addToolUseMessage(content: string, toolUses: ToolUseBlock[]): void {
    this.history.push({ role: "assistant", content, toolUses });
  }

  addAssistantMessageWithTools(content: string, toolUses: ToolUseBlock[]): void {
    this.addToolUseMessage(content, toolUses);
  }

  addToolResultMessage(toolResults: ToolResultBlock[]): void {
    this.history.push({ role: "user", content: "", toolResults });
  }

  addToolResultsMessage(toolResults: ToolResultBlock[]): void {
    this.addToolResultMessage(toolResults);
  }

  addSystemReminder(content: string): void {
    this.history.push({ role: "system", content });
  }

  injectLongTermMemory(_content: string): void {
    this.ltmInjected = true;
  }

  replaceWithCompacted(messages: Message[]): void {
    this.history = [...messages];
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
