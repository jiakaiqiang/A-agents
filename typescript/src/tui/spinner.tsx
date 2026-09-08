import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { useEffect, useMemo, useState } from "react";
import type { LoopPhase } from "../agent/events.js";
import { brand, symbols } from "./styles.js";
import { randomVerb } from "./verbs.js";

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}

export function Spinner({
  inputTokens = 0,
  outputTokens = 0,
  iteration = 0,
  phase = "model",
}: {
  inputTokens?: number;
  outputTokens?: number;
  iteration?: number;
  phase?: LoopPhase;
}) {
  const [elapsed, setElapsed] = useState(0);
  const label = useMemo(randomVerb, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginLeft={1}>
      <Text color={brand.primary}><InkSpinner type="dots" /> {label}…</Text>
      {/* 迭代序号缺省为 0 时不渲染，纯文本对话的呈现与本章之前一致。 */}
      {iteration > 0 ? (
        <Text color={brand.tool}> 第 {iteration} 轮 {symbols.separator} {phase === "tools" ? "执行工具" : "等待模型"}</Text>
      ) : null}
      <Text color={brand.muted}> ({formatTokens(inputTokens)}↓ {formatTokens(outputTokens)}↑ {symbols.separator} {elapsed}s)</Text>
    </Box>
  );
}
