import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Suggestion } from "../commands/types.js";
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
  suggest,
  suggestionsOpenRef,
}: {
  onSubmit: (text: string) => boolean;
  disabled?: boolean;
  history?: string[];
  suggest?: (text: string) => Suggestion[];
  suggestionsOpenRef?: { current: boolean };
}) {
  const [lines, setLines] = useState([""]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [cursor, setCursor] = useState<Cursor>({ line: 0, column: 0 });
  // 补全列表（斜杠命令 spec F10）：-1 表示「用初始高亮」；Esc 收起后到下次输入变化前不再弹出。
  const [highlight, setHighlight] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const text = lines.join("\n");
  const items = suggest?.(text) ?? [];
  const open = items.length > 0 && !dismissed;
  // 完全匹配项优先高亮：完整输入 /do、/resume 回车时行为与没有列表时一致。
  const exact = items.findIndex((item) => `/${item.name}` === text.toLowerCase());
  const current = highlight >= 0 ? Math.min(highlight, items.length - 1) : Math.max(exact, 0);
  // 渲染期写入：App 的 Esc 中断判断与本组件的按键处理执行先后无关。
  if (suggestionsOpenRef) suggestionsOpenRef.current = open;

  useEffect(() => {
    setHighlight(-1);
    setDismissed(false);
  }, [lines]);

  useEffect(() => () => {
    if (suggestionsOpenRef) suggestionsOpenRef.current = false;
  }, [suggestionsOpenRef]);

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
    // 列表可见时 ↑↓/Tab/Enter/Esc 归补全；不可见时走原有的翻历史与编辑逻辑。
    if (open) {
      if (key.upArrow) {
        setHighlight(Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setHighlight(Math.min(items.length - 1, current + 1));
        return;
      }
      if (key.tab && !key.shift) {
        const filled = `/${items[current]!.name} `;
        setLines([filled]);
        setCursor({ line: 0, column: filled.length });
        return;
      }
      if (key.return && !key.shift && !key.ctrl) {
        if (!onSubmit(`/${items[current]!.name}`)) return;
        setLines([""]);
        setHistoryIndex(null);
        setCursor({ line: 0, column: 0 });
        return;
      }
      if (key.escape) {
        setDismissed(true);
        return;
      }
    }
    if (key.return && !key.shift && !key.ctrl) {
      const text = lines.join("\n").trim();
      if (text && !onSubmit(text)) return;
      setLines([""]);
      setHistoryIndex(null);
      setCursor({ line: 0, column: 0 });
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
    if (key.tab || key.escape) return;
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
      {open && items.map((item, index) => (
        <Text key={item.name} color={index === current ? brand.primary : brand.muted}>
          {index === current ? "❯" : " "} /{item.name}  {item.description}
        </Text>
      ))}
    </Box>
  );
}
