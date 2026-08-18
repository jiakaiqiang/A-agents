export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string }
  | {
    type: "tool_call_complete";
    toolId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    parseError?: string;
  }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };

export const emptyUsage = (): UsageInfo => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});
