import chalk from "chalk";
import { Box, Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { brand, symbols } from "./styles.js";

chalk.level = 3;
marked.use(markedTerminal({ showSectionPrefix: false }) as never);

export type ChatRole = "user" | "assistant" | "system" | "thinking" | "tool_use" | "tool_result" | "turn_summary";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  isError?: boolean;
  toolId?: string;
}

export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return text;
  }
}

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return <Text color={brand.user}>{symbols.prompt} {message.content}</Text>;
  }
  if (message.role === "system" || message.role === "thinking") {
    return <Text color={message.isError ? brand.error : brand.muted}>{message.content}</Text>;
  }
  if (message.role === "tool_use" || message.role === "tool_result") {
    // 工具行只展示摘要，不走 markdown 渲染，避免把工具输出当正文美化。
    return <Text color={message.isError ? brand.error : brand.tool}>{message.content}</Text>;
  }
  return <Text color={message.isError ? brand.error : brand.assistant}>{renderMarkdown(message.content)}</Text>;
}

export function ChatView({ messages, streamingText }: { messages: ChatMessage[]; streamingText?: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {messages.map((message, index) => <MessageBlock key={`${message.role}-${index}`} message={message} />)}
      {streamingText ? <Text color={brand.assistant}>{symbols.dot} {streamingText}</Text> : null}
    </Box>
  );
}

export function CommittedMessage({ message }: { message: ChatMessage }) {
  return (
    <Box paddingLeft={1}>
      <MessageBlock message={message} />
    </Box>
  );
}

/**
 * 启动横幅整个会话只写出一次，所以它属于静态区。
 * 留在动态区的话每次重渲染都要重画一遍，长对话下会反复出现。
 */
export function Banner({
  providerName,
  model,
  workDir,
}: {
  providerName: string;
  model: string;
  workDir: string;
}) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={brand.primary}> /\_/\</Text>
      <Text color={brand.primary}>( o.o )</Text>
      <Text color={brand.primary}> &gt; ^ &lt;</Text>
      <Text color={brand.bright}>MewCode v0.1.0</Text>
      <Text color={brand.muted}>{providerName} {symbols.separator} {model} {symbols.separator} {workDir}</Text>
    </Box>
  );
}
