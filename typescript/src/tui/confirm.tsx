import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ConfirmChoice, ConfirmRequest } from "../permission/types.js";
import { brand, symbols } from "./styles.js";

const OPTIONS: Array<{ choice: ConfirmChoice; label: string }> = [
  { choice: "once", label: "本次放行" },
  { choice: "session", label: "本会话放行" },
  { choice: "always", label: "永久放行" },
  { choice: "deny", label: "拒绝" },
];

/**
 * 权限确认框（权限 spec F20）。
 * 弹出期间独占方向键与 Enter；输入框在 app 侧让位，避免两处同时吃键盘。
 */
export function ConfirmBox({
  request,
  onChoose,
}: {
  request: ConfirmRequest;
  onChoose: (choice: ConfirmChoice) => void;
}) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
    if (key.downArrow) setCursor((value) => Math.min(OPTIONS.length - 1, value + 1));
    if (key.return) onChoose(OPTIONS[cursor]!.choice);
  });

  const current = OPTIONS[cursor]!;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={brand.bright}>{symbols.prompt} 需要确认：{request.summary}</Text>
      {OPTIONS.map((option, index) => (
        <Text key={option.choice} color={index === cursor ? brand.primary : brand.muted}>
          {index === cursor ? `${symbols.arrow} ` : "  "}{option.label}
        </Text>
      ))}
      {/* 永久放行的授权范围要在点头前看清，避免一次确认授出比预期更大的权限。 */}
      {current.choice === "always"
        ? <Text color={brand.muted}>将写入本地配置：{request.ruleCandidate}</Text>
        : null}
      <Text color={brand.muted}>↑/↓ 选择，Enter 确认。</Text>
    </Box>
  );
}
