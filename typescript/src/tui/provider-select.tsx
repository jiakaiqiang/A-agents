import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ProviderConfig } from "../config/config.js";
import { brand, symbols } from "./styles.js";

export function ProviderSelect({ providers, onSelect }: { providers: ProviderConfig[]; onSelect: (provider: ProviderConfig) => void }) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
    if (key.downArrow) setCursor((value) => Math.min(providers.length - 1, value + 1));
    if (key.return) onSelect(providers[cursor]!);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={brand.bright}>选择本次会话的 provider：</Text>
      {providers.map((provider, index) => (
        <Text key={`${provider.name}-${provider.model}`} color={index === cursor ? brand.primary : brand.muted}>
          {index === cursor ? `${symbols.prompt} ` : "  "}{provider.name} ({provider.protocol} {symbols.arrow} {provider.model})
        </Text>
      ))}
      <Text color={brand.muted}>使用 ↑/↓ 选择，Enter 确认。</Text>
    </Box>
  );
}
