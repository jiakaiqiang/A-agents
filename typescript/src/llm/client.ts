import type { ProviderConfig } from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { SystemPromptSegments } from "../prompt/builder.js";
import type { StreamEvent } from "./events.js";

/** 单次请求的可选参数。reminders 只挂在这一次请求上，不写入会话历史。 */
export interface StreamOptions {
  signal?: AbortSignal;
  reminders?: string[];
}

export interface LLMClient {
  stream(
    conversation: ConversationManager,
    tools: Record<string, unknown>[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent>;
}

export interface MaxTokensSetter {
  setMaxOutputTokens(tokens: number): void;
}

export async function createClient(
  config: ProviderConfig,
  segments: SystemPromptSegments,
): Promise<LLMClient> {
  if (config.protocol === "anthropic") {
    const { AnthropicClient } = await import("./anthropic.js");
    const client = new AnthropicClient(config, segments);
    return {
      stream(conversation, tools, options) {
        return client.stream(conversation.getMessages(), tools, options);
      },
    };
  }

  const { OpenAIClient, OpenAICompatClient } = await import("./openai.js");
  const client = config.protocol === "openai"
    ? new OpenAIClient(config, segments)
    : new OpenAICompatClient(config, segments);
  return {
    stream(conversation, tools, options) {
      return client.stream(conversation.getMessages(), tools, options);
    },
  };
}
