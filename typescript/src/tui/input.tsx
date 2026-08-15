import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { brand, borderColors, symbols } from "./styles.js";

export function InputBox({
  onSubmit,
  disabled = false,
  history = [],
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  history?: string[];
}) {
  const [lines, setLines] = useState([""]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((value) => !value), 530);
    return () => clearInterval(timer);
  }, []);

  useInput((input, key) => {
    if (disabled) return;
    if (key.return && !key.shift && !key.ctrl) {
      const text = lines.join("\n").trim();
      if (text) onSubmit(text);
      setLines([""]);
      setHistoryIndex(null);
      return;
    }
    if ((key.return && (key.shift || key.ctrl)) || (key.ctrl && input === "j")) {
      setLines((current) => [...current, ""]);
      return;
    }
    if (key.upArrow && history.length) {
      setHistoryIndex((current) => {
        const next = current === null ? history.length - 1 : Math.max(0, current - 1);
        setLines(history[next]!.split("\n"));
        return next;
      });
      return;
    }
    if (key.downArrow && history.length) {
      setHistoryIndex((current) => {
        if (current === null) return null;
        const next = current + 1;
        if (next >= history.length) {
          setLines([""]);
          return null;
        }
        setLines(history[next]!.split("\n"));
        return next;
      });
      return;
    }
    if (key.backspace || key.delete) {
      setLines((current) => {
        const next = [...current];
        const last = next.length - 1;
        if (next[last]) next[last] = next[last]!.slice(0, -1);
        else if (next.length > 1) next.pop();
        return next;
      });
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setLines((current) => {
        const next = [...current];
        next[next.length - 1] += input;
        return next;
      });
    }
  });

  if (disabled) return <Text color={brand.muted}>Waiting...</Text>;

  return (
    <Box borderStyle="round" borderColor={borderColors.focus} flexDirection="column" paddingX={1} marginTop={1}>
      {lines.map((line, index) => (
        <Text key={index} color={brand.user}>
          {index === 0 ? `${symbols.prompt} ` : "  "}{line}{index === lines.length - 1 && cursorVisible ? <Text color={brand.primary}>▌</Text> : ""}
        </Text>
      ))}
      {lines.length === 1 && !lines[0] && <Text color={brand.muted}>输入消息，Enter 发送，Shift+Enter 换行</Text>}
    </Box>
  );
}
