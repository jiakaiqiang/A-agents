import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { Message } from "../conversation/conversation.js";
import type { ProviderConfig } from "../config/config.js";
import { getMaxOutputTokens, resolveAPIKey } from "../config/config.js";
import { AuthenticationError, ContextTooLongError, LLMError, NetworkError, RateLimitError } from "./errors.js";
import { emptyUsage, type StreamEvent } from "./events.js";

export function buildOpenAIInput(history: Message[]): ResponseInput {
  const input: Array<Record<string, unknown>> = [];
  for (const entry of history) {
    if (entry.role === "assistant" && entry.toolUses?.length) {
      if (entry.content) input.push({ role: "assistant", content: entry.content });
      for (const tool of entry.toolUses) {
        input.push({ type: "function_call", call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments) });
      }
    } else if (entry.role === "user" && entry.toolResults?.length) {
      for (const result of entry.toolResults) {
        input.push({ type: "function_call_output", call_id: result.toolUseId, output: result.content });
      }
    } else {
      input.push({ role: entry.role, content: entry.content });
    }
  }
  return input as unknown as ResponseInput;
}

export function buildChatCompletionMessages(history: Message[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  for (const entry of history) {
    if (entry.role === "assistant" && entry.toolUses?.length) {
      messages.push({
        role: "assistant",
        content: entry.content || null,
        tool_calls: entry.toolUses.map((tool) => ({
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        })),
      });
    } else if (entry.role === "user" && entry.toolResults?.length) {
      for (const result of entry.toolResults) {
        messages.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
      }
    } else {
      messages.push({ role: entry.role, content: entry.content } as ChatCompletionMessageParam);
    }
  }
  return messages;
}

function classifyOpenAIError(error: unknown): Error {
  if (error instanceof OpenAI.AuthenticationError) return new AuthenticationError(error.message);
  if (error instanceof OpenAI.RateLimitError) {
    return new RateLimitError(error.message, error.headers?.get("retry-after") ?? undefined);
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status === 413 || (error.status === 400 && /context_length_exceeded|maximum context length|prompt is too long/i.test(error.message))) {
      return new ContextTooLongError(error.message);
    }
    return new LLMError(error.message);
  }
  if (error instanceof Error && error.name === "AbortError") return error;
  return new NetworkError(error instanceof Error ? error.message : "网络连接失败");
}

abstract class BaseOpenAIClient {
  protected readonly client: OpenAI;
  protected readonly maxOutputTokens: number;

  constructor(protected readonly config: ProviderConfig, protected readonly systemPrompt: string) {
    const apiKey = resolveAPIKey(config);
    if (!apiKey) throw new AuthenticationError("缺少 OpenAI API 密钥：请设置 api_key 或 OPENAI_API_KEY。");
    this.client = new OpenAI({ apiKey, baseURL: config.base_url });
    this.maxOutputTokens = getMaxOutputTokens(config);
  }

  setMaxOutputTokens(_tokens: number): void {
    // 保留给后续章节的动态输出额度控制。
  }
}

export class OpenAIClient extends BaseOpenAIClient {
  async *stream(history: Message[], tools: Record<string, unknown>[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const usage = emptyUsage();
    let stopReason = "end_turn";
    const functionCalls = new Map<string, { name: string; arguments: string }>();

    try {
      const stream = await this.client.responses.create({
        model: this.config.model,
        input: [
          { role: "system", content: this.systemPrompt },
          ...(buildOpenAIInput(history) as unknown as Array<Record<string, unknown>>),
        ] as unknown as ResponseInput,
        stream: true,
        max_output_tokens: this.maxOutputTokens,
        ...(tools.length ? { tools: tools as never[] } : {}),
      }, { signal });

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text_delta", text: event.delta };
        } else if (event.type === "response.output_item.added" && event.item.type === "function_call") {
          functionCalls.set(event.item.call_id, { name: event.item.name, arguments: "" });
          yield { type: "tool_call_start", toolId: event.item.call_id, toolName: event.item.name };
        } else if (event.type === "response.function_call_arguments.delta") {
          const current = functionCalls.get(event.item_id);
          if (current) current.arguments += event.delta;
          yield { type: "tool_call_delta", text: event.delta };
        } else if (event.type === "response.output_item.done" && event.item.type === "function_call") {
          const current = functionCalls.get(event.item.call_id) ?? { name: event.item.name, arguments: event.item.arguments };
          let argumentsValue: Record<string, unknown> = {};
          try { argumentsValue = JSON.parse(current.arguments || event.item.arguments) as Record<string, unknown>; } catch { /* 工具参数无效时交由工具循环处理 */ }
          yield { type: "tool_call_complete", toolId: event.item.call_id, toolName: current.name, arguments: argumentsValue };
        } else if (event.type === "response.completed") {
          const response = event.response;
          stopReason = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
            ? "max_tokens"
            : "end_turn";
          usage.outputTokens = response.usage?.output_tokens ?? 0;
          usage.cacheReadInputTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
          usage.inputTokens = Math.max(0, (response.usage?.input_tokens ?? 0) - usage.cacheReadInputTokens);
        }
      }
    } catch (error) {
      throw classifyOpenAIError(error);
    }

    yield { type: "stream_end", stopReason, usage };
  }
}

export class OpenAICompatClient extends BaseOpenAIClient {
  async *stream(history: Message[], tools: Record<string, unknown>[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const usage = emptyUsage();
    let stopReason = "end_turn";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: "system", content: this.systemPrompt }, ...buildChatCompletionMessages(history)],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: this.maxOutputTokens,
        ...(tools.length ? { tools: tools as never[] } : {}),
      }, { signal });

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
          usage.cacheReadInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage.inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - usage.cacheReadInputTokens);
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) yield { type: "text_delta", text: choice.delta.content };
        for (const delta of choice.delta.tool_calls ?? []) {
          const current = toolCalls.get(delta.index) ?? { id: delta.id ?? "", name: delta.function?.name ?? "", arguments: "" };
          if (delta.id) current.id = delta.id;
          if (delta.function?.name) current.name = delta.function.name;
          if (delta.function?.arguments) {
            current.arguments += delta.function.arguments;
            yield { type: "tool_call_delta", text: delta.function.arguments };
          }
          const isNew = !toolCalls.has(delta.index);
          toolCalls.set(delta.index, current);
          if (isNew && current.id && current.name) yield { type: "tool_call_start", toolId: current.id, toolName: current.name };
        }
        if (choice.finish_reason) {
          stopReason = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
        }
      }
    } catch (error) {
      throw classifyOpenAIError(error);
    }

    for (const tool of toolCalls.values()) {
      let argumentsValue: Record<string, unknown> = {};
      try { argumentsValue = JSON.parse(tool.arguments) as Record<string, unknown>; } catch { /* 交由后续工具循环处理 */ }
      yield { type: "tool_call_complete", toolId: tool.id, toolName: tool.name, arguments: argumentsValue };
    }
    yield { type: "stream_end", stopReason, usage };
  }
}
