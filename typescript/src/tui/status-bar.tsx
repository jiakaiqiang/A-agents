import { Box, Text } from "ink";
import { brand, symbols } from "./styles.js";

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}

export function StatusBar({
  model,
  mode = "聊天",
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
}: {
  model: string;
  mode?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}) {
  // 命中与写入分开显示：只看总量分不清是省下来的还是刚花钱建的缓存。
  const cache = cacheReadTokens > 0 || cacheCreationTokens > 0
    ? ` ${symbols.separator} 缓存 ${formatTokens(cacheReadTokens)}⚡ ${formatTokens(cacheCreationTokens)}✎`
    : "";
  return (
    <Box marginTop={1}>
      <Text color={brand.muted}>{mode} {symbols.separator} {model} {symbols.separator} {formatTokens(inputTokens)}↓ {formatTokens(outputTokens)}↑{cache}</Text>
    </Box>
  );
}
