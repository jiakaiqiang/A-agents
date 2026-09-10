import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { brand, borderColors, symbols } from "./styles.js";

/**
 * 光标位置按「行号 + 列号」表示。行内编辑只影响当前行的列号；
 * 上下换行/历史切换会把光标移到行首或行尾。
 */
interface Cursor {
  line: number;
  column: number;
}

const endOf = (line: string): number => line.length;

function clampCursor(lines: string[], cursor: Cursor): Cursor {
  const line = Math.min(cursor.line, lines.length - 1);
  return { line, column: Math.min(cursor.column, endOf(lines[line]!)) };
}

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
  const [cursor, setCursor] = useState<Cursor>({ line: 0, column: 0 });

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((value) => !value), 530);
    return () => clearInterval(timer);
  }, []);

  // 行集或行内容变化时光标可能越界（删除、换行、历史替换），统一在这里收敛。
  useEffect(() => {
    setCursor((current) => clampCursor(lines, current));
  }, [lines]);

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
      setLines((current) => {
        const next = [...current];
        next.splice(cursor.line + 1, 0, "");
        return next;
      });
      setCursor({ line: cursor.line + 1, column: 0 });
      return;
    }
    if (key.upArrow && history.length) {
      // ↑ 在多行编辑里是移动光标；只有单行时才翻历史，避免抢键。
      if (lines.length > 1) {
        if (cursor.line === 0) return;
        setCursor({ line: cursor.line - 1, column: endOf(lines[cursor.line - 1]!) });
        return;
      }
      setHistoryIndex((current) => {
        const next = current === null ? history.length - 1 : Math.max(0, current - 1);
        setLines(history[next]!.split("\n"));
        setCursor({ line: 0, column: 0 });
        return next;
      });
      return;
    }
    if (key.downArrow && history.length) {
      if (lines.length > 1) {
        if (cursor.line >= lines.length - 1) return;
        setCursor({ line: cursor.line + 1, column: endOf(lines[cursor.line + 1]!) });
        return;
      }
      setHistoryIndex((current) => {
        if (current === null) return null;
        const next = current + 1;
        if (next >= history.length) {
          setLines([""]);
          setCursor({ line: 0, column: 0 });
          return null;
        }
        setLines(history[next]!.split("\n"));
        setCursor({ line: 0, column: 0 });
        return next;
      });
      return;
    }

    // 左右移动：行内移动，越界时跨到上/下一行的尾/首（与 readline 行为一致）。
    if (key.leftArrow) {
      if (cursor.column > 0) {
        setCursor({ ...cursor, column: cursor.column - 1 });
      } else if (cursor.line > 0) {
        setCursor({ line: cursor.line - 1, column: endOf(lines[cursor.line - 1]!) });
      }
      return;
    }
    if (key.rightArrow) {
      if (cursor.column < endOf(lines[cursor.line]!)) {
        setCursor({ ...cursor, column: cursor.column + 1 });
      } else if (cursor.line < lines.length - 1) {
        setCursor({ line: cursor.line + 1, column: 0 });
      }
      return;
    }

    // 行首行尾跳转（readline 的 Ctrl+A / Ctrl+E）。
    if (key.ctrl && input === "a") {
      setCursor({ ...cursor, column: 0 });
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor({ ...cursor, column: endOf(lines[cursor.line]!) });
      return;
    }

    if (key.backspace || key.delete) {
      // backspace 与 delete 都往前删（删光标左侧字符），行首时与上一行拼接。
      if (cursor.column > 0) {
        setLines((current) => {
          const next = [...current];
          const line = next[cursor.line]!;
          next[cursor.line] = line.slice(0, cursor.column - 1) + line.slice(cursor.column);
          return next;
        });
        setCursor({ ...cursor, column: cursor.column - 1 });
      } else if (cursor.line > 0) {
        setLines((current) => {
          const next = [...current];
          const previous = next[cursor.line - 1]!;
          next[cursor.line - 1] = previous + next[cursor.line]!;
          next.splice(cursor.line, 1);
          return next;
        });
        setCursor({ line: cursor.line - 1, column: endOf(lines[cursor.line - 1]!) });
      }
      return;
    }
    // Tab / Shift+Tab 由 app 层处理档位切换，不插入文本。
    if (key.tab) return;
    if (!key.ctrl && !key.meta && input) {
      setLines((current) => {
        const next = [...current];
        const line = next[cursor.line]!;
        next[cursor.line] = line.slice(0, cursor.column) + input + line.slice(cursor.column);
        return next;
      });
      setCursor({ ...cursor, column: cursor.column + input.length });
    }
  });

  if (disabled) return <Text color={brand.muted}>Waiting...</Text>;

  return (
    <Box borderStyle="round" borderColor={borderColors.focus} flexDirection="column" paddingX={1} marginTop={1}>
      {lines.map((line, index) => {
        const active = index === cursor.line && !disabled;
        const cursorText = index === cursor.line ? line.slice(0, cursor.column) : line;
        const afterText = index === cursor.line ? line.slice(cursor.column) : "";
        return (
          <Text key={index} color={brand.user}>
            {index === 0 ? `${symbols.prompt} ` : "  "}{cursorText}{active && cursorVisible ? <Text color={brand.primary}>▌</Text> : ""}{afterText}
          </Text>
        );
      })}
      {lines.length === 1 && !lines[0] && <Text color={brand.muted}>输入消息，Enter 发送，Shift+Enter 换行，Shift+Tab 切换权限档位</Text>}
    </Box>
  );
}
