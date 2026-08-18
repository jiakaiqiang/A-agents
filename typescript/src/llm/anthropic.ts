import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../conversation/conversation.js";
import type { ProviderConfig } from "../config/config.js";
import { getContextWindow, getMaxOutputTokens, resolveAPIKey } from "../config/config.js";
import { AuthenticationError, ContextTooLongError, LLMError, NetworkError, RateLimitError } from "./errors.js";
import { emptyUsage, type StreamEvent, type UsageInfo } from "./events.js";

export function buildAnthropicMessages(history: Message[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const entry of history) {
    if (entry.role === "system") continue;

    if (entry.role === "user" && entry.toolResults?.length) {
      const content: Anthropic.ToolResultBlockParam[] = entry.toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.toolUseId,
        content: result.content,
        is_error: result.isError,
      }));
      messages.push({ role: "user", content });
      continue;
    }

    if (entry.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const thinking of entry.thinkingBlocks ?? []) {
        content.push({ type: "thinking", thinking: thinking.thinking, signature: thinking.signature });
      }
      if (entry.content) content.push({ type: "text", text: entry.content });
      for (const tool of entry.toolUses ?? []) {
        content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.arguments });
      }
      messages.push({ role: "assistant", content: content.length ? content : "" });
      continue;
    }

    const previous = messages[messages.length - 1];
    if (previous?.role === "user" && typeof previous.content === "string") {
      previous.content = `${previous.content}\n\n${entry.content}`; // 这一步的场景就是用户连续输入多条信息  然后合并后再交给agent处理
    } else {
      messages.push({ role: "user", content: entry.content });
    }
  }
  return messages;
}

export function markLastUserTailForCache(messages: Anthropic.MessageParam[]): void {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser || typeof lastUser.content === "string" || lastUser.content.length === 0) return;
  const last = lastUser.content[lastUser.content.length - 1];
  if (last.type === "text") {
    Object.assign(last, { cache_control: { type: "ephemeral" } });
  }
}

export async function fetchModelContextWindow(config: ProviderConfig): Promise<number> {
  if (config.protocol !== "anthropic") return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(
      `${config.base_url.replace(/\/$/, "")}/v1/models/${encodeURIComponent(config.model)}`,
      {
        headers: {
          "anthropic-version": "2023-06-01",
          ...(resolveAPIKey(config) ? { "x-api-key": resolveAPIKey(config) } : {}),
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) return 0;
    const payload = await response.json() as { max_input_tokens?: unknown };
    return typeof payload.max_input_tokens === "number" ? payload.max_input_tokens : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

function classifyAnthropicError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) return new AuthenticationError(error.message);
  if (error instanceof Anthropic.RateLimitError) {
    return new RateLimitError(error.message, error.headers?.get("retry-after") ?? undefined);
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status === 413 || /prompt is too long|context/i.test(error.message)) {
      return new ContextTooLongError(error.message);
    }
    return new LLMError(error.message);
  }
  if (error instanceof Error && error.name === "AbortError") return error;
  return new NetworkError(error instanceof Error ? error.message : "网络连接失败");
}

function supportsAdaptiveThinking(model: string): boolean {
  return /^(claude-(?:fable|mythos)-5|claude-(?:opus|sonnet)-[45](?:-|$))/.test(model);
}

export class AnthropicClient {
  private readonly client: Anthropic;
  private readonly maxOutputTokens: number;
  readonly contextWindow: number;

  constructor(private readonly config: ProviderConfig, private readonly systemPrompt: string) {
    const apiKey = resolveAPIKey(config);
    if (!apiKey) {
      throw new AuthenticationError("缺少 Anthropic API 密钥：请设置 api_key 或 ANTHROPIC_API_KEY。");
    }
    this.client = new Anthropic({ apiKey, baseURL: config.base_url });
    this.maxOutputTokens = getMaxOutputTokens(config);
    this.contextWindow = getContextWindow(config);
  }

  setMaxOutputTokens(_tokens: number): void {
    // 当前会话按 provider 配置固定上限；保留接口以便后续章节扩展。
  }

  async *stream(history: Message[], tools: Record<string, unknown>[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const messages = buildAnthropicMessages(history);
    markLastUserTailForCache(messages);
    const usage = emptyUsage();
    let stopReason = "end_turn";
    const thinkingByIndex = new Map<number, { thinking: string; signature: string }>();
    const toolsByIndex = new Map<number, { id: string; name: string; json: string }>();

    try {
      const params: Anthropic.MessageCreateParamsStreaming = {
        model: this.config.model,
        max_tokens: this.maxOutputTokens,
        stream: true,
        system: [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
        ...(tools.length ? { tools: tools as unknown as Anthropic.Tool[] } : {}),
      };
      if (this.config.thinking) {
        Object.assign(params, supportsAdaptiveThinking(this.config.model)
          ? { thinking: { type: "adaptive" } }
          : { thinking: { type: "enabled", budget_tokens: this.maxOutputTokens - 1 } });
      }

      const stream = this.client.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type === "message_start") {
          usage.inputTokens = event.message.usage.input_tokens;
          usage.outputTokens = event.message.usage.output_tokens;
          usage.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens ?? 0;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "thinking") {
            thinkingByIndex.set(event.index, { thinking: "", signature: "" });
          } else if (event.content_block.type === "tool_use") {
            toolsByIndex.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
            yield { type: "tool_call_start", toolId: event.content_block.id, toolName: event.content_block.name };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "thinking_delta") {
            const current = thinkingByIndex.get(event.index);
            if (current) current.thinking += event.delta.thinking;
            yield { type: "thinking_delta", text: event.delta.thinking };
          } else if (event.delta.type === "signature_delta") {
            const current = thinkingByIndex.get(event.index);
            if (current) current.signature += event.delta.signature;
          } else if (event.delta.type === "input_json_delta") {
            const current = toolsByIndex.get(event.index);
            if (current) current.json += event.delta.partial_json;
            yield { type: "tool_call_delta", text: event.delta.partial_json };
          }
        } else if (event.type === "content_block_stop") {
          const thinking = thinkingByIndex.get(event.index);
          if (thinking) yield { type: "thinking_complete", ...thinking };
          const tool = toolsByIndex.get(event.index);
          if (tool) {
            let argumentsValue: Record<string, unknown> = {};
            let parseError: string | undefined;
            try {
              argumentsValue = JSON.parse(tool.json) as Record<string, unknown>;
            } catch (error) {
              parseError = error instanceof Error ? error.message : String(error);
            }
            yield {
              type: "tool_call_complete",
              toolId: tool.id,
              toolName: tool.name,
              arguments: argumentsValue,
              ...(parseError ? { parseError } : {}),
            };
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason ?? stopReason;
          usage.outputTokens = event.usage.output_tokens;
        }
      }
    } catch (error) {
      throw classifyAnthropicError(error);
    }

    yield { type: "stream_end", stopReason, usage };
  }
}

export function toUsageInfo(usage: Partial<UsageInfo>): UsageInfo {
  return { ...emptyUsage(), ...usage };
}
