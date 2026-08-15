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
}: {
  model: string;
  mode?: string;
  inputTokens?: number;
  outputTokens?: number;
}) {
  return (
    <Box marginTop={1}>
      <Text color={brand.muted}>{mode} {symbols.separator} {model} {symbols.separator} {formatTokens(inputTokens)}↓ {formatTokens(outputTokens)}↑</Text>
    </Box>
  );
}
