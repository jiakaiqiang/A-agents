import type { ProviderConfig } from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { StreamEvent } from "./events.js";

export interface LLMClient {
  stream(
    conversation: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
}

export interface MaxTokensSetter {
  setMaxOutputTokens(tokens: number): void;
}

export async function createClient(config: ProviderConfig, systemPrompt: string): Promise<LLMClient> {
  if (config.protocol === "anthropic") {
    const { AnthropicClient } = await import("./anthropic.js");
    const client = new AnthropicClient(config, systemPrompt);
    return {
      stream(conversation, tools, abortSignal) {
        return client.stream(conversation.getMessages(), tools, abortSignal);
      },
    };
  }

  const { OpenAIClient, OpenAICompatClient } = await import("./openai.js");
  const client = config.protocol === "openai"
    ? new OpenAIClient(config, systemPrompt)
    : new OpenAICompatClient(config, systemPrompt);
  return {
    stream(conversation, tools, abortSignal) {
      return client.stream(conversation.getMessages(), tools, abortSignal);
    },
  };
}
