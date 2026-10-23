import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import type { SessionInfo } from "../memory/session.js";
import { brand, symbols } from "./styles.js";

export function SessionSelect({ sessions, onSelect, onCancel }: {
  sessions: SessionInfo[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const { stdout } = useStdout();
  const visible = Math.max(1, Math.min(8, (stdout.rows || 24) - 10));
  const start = Math.max(0, cursor - visible + 1);
  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
    else if (key.downArrow) setCursor((value) => Math.min(sessions.length - 1, value + 1));
    else if (key.return && sessions[cursor]) onSelect(sessions[cursor]!.id);
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={brand.bright}>恢复历史会话（{cursor + 1}/{sessions.length}）：</Text>
      {sessions.slice(start, start + visible).map((session, index) => (
        <Text key={session.id} wrap="truncate-end" color={start + index === cursor ? brand.primary : brand.muted}>
          {start + index === cursor ? `${symbols.prompt} ` : "  "}{session.title} · {session.lastActive.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} · {session.messageCount} 条{session.inUse ? " · 使用中" : ""}
        </Text>
      ))}
      <Text color={brand.muted}>↑/↓ 选择，Enter 恢复，Esc 取消</Text>
    </Box>
  );
}
