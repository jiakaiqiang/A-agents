import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { useEffect, useMemo, useState } from "react";
import { brand, symbols } from "./styles.js";
import { randomVerb } from "./verbs.js";

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}

export function Spinner({ inputTokens = 0, outputTokens = 0 }: { inputTokens?: number; outputTokens?: number }) {
  const [elapsed, setElapsed] = useState(0);
  const label = useMemo(randomVerb, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginLeft={1}>
      <Text color={brand.primary}><InkSpinner type="dots" /> {label}…</Text>
      <Text color={brand.muted}> ({formatTokens(inputTokens)}↓ {formatTokens(outputTokens)}↑ {symbols.separator} {elapsed}s)</Text>
    </Box>
  );
}
