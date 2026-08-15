import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { HookConfig, MCPServerConfig, ProviderConfig } from "../config/config.js";
import { getContextWindowAsync } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { InputBox } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { brand, symbols } from "./styles.js";
import { randomCompletionVerb } from "./verbs.js";

type AppState = "providerSelect" | "chat";

export function App({
  providers,
  mcpServers: _mcpServers,
  hooks: _hooks,
}: {
  providers: ProviderConfig[];
  mcpServers: MCPServerConfig[];
  hooks: HookConfig[];
}) {
  const { exit } = useApp();
  const [appState, setAppState] = useState<AppState>(providers.length === 1 ? "chat" : "providerSelect");
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig>(providers[0]!);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [completionMark, setCompletionMark] = useState("");
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);

  const clientRef = useRef<LLMClient | null>(null);
  const conversationRef = useRef(new ConversationManager());
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef("");
  const committedIndexRef = useRef(0);
  const workDir = process.cwd();

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      abortControllerRef.current?.abort();
      exit();
    }
  });

  useEffect(() => {
    if (appState !== "chat" || !selectedProvider) return;
    let cancelled = false;
    const systemPrompt = buildSystemPrompt(detectEnvironment(workDir, selectedProvider.model));
    clientRef.current = null;
    void createClient(selectedProvider, systemPrompt)
      .then((client) => {
        if (!cancelled) clientRef.current = client;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    void getContextWindowAsync(selectedProvider).catch(() => undefined);
    return () => { cancelled = true; };
  }, [appState, selectedProvider, workDir]);

  async function runAgentLoop(): Promise<void> {
    const client = clientRef.current;
    if (!client) {
      setError("正在初始化 LLM 客户端，请稍后重试。");
      setIsStreaming(false);
      return;
    }

    let fullText = "";
    try {
      for await (const event of client.stream(conversationRef.current, [], abortControllerRef.current?.signal)) {
        if (event.type === "text_delta") {
          fullText += event.text;
          streamingTextRef.current = fullText;
          setStreamingText(fullText);
        } else if (event.type === "stream_end") {
          setInputTokens(event.usage.inputTokens);
          setOutputTokens(event.usage.outputTokens);
        }
      }
      if (fullText) {
        conversationRef.current.addAssistantMessage(fullText);
        setMessages((previous) => {
          const next: ChatMessage[] = [...previous, { role: "assistant", content: fullText }];
          committedIndexRef.current = next.length;
          return next;
        });
        setCompletionMark(randomCompletionVerb());
      } else {
        setError("模型返回了空内容，请检查 provider 协议、端点地址和模型名称。");
      }
    } catch (cause) {
      if (fullText) {
        conversationRef.current.addAssistantMessage(fullText);
        setMessages((previous) => {
          const next: ChatMessage[] = [...previous, { role: "assistant", content: fullText }];
          committedIndexRef.current = next.length;
          return next;
        });
      }
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      setError(message);
    } finally {
      setIsStreaming(false);
      setStreamingText("");
      streamingTextRef.current = "";
      abortControllerRef.current = null;
    }
  }

  function handleSubmit(text: string): void {
    if (isStreaming) return;
    if (text === "/exit") {
      exit();
      return;
    }

    setPromptHistory((previous) => [...previous, text]);
    setMessages((previous) => [...previous, { role: "user", content: text }]);
    conversationRef.current.addUserMessage(text);
    setCompletionMark("");
    setError(null);
    setStreamingText("");
    setIsStreaming(true);
    abortControllerRef.current = new AbortController();
    void runAgentLoop();
  }

  if (appState === "providerSelect") {
    return <ProviderSelect providers={providers} onSelect={(provider) => { setSelectedProvider(provider); setAppState("chat"); }} />;
  }

  const committed = messages.slice(0, committedIndexRef.current);
  const active = messages.slice(committedIndexRef.current);
  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column">
        <Text color={brand.primary}> /\_/\</Text>
        <Text color={brand.primary}>( o.o )</Text>
        <Text color={brand.primary}> &gt; ^ &lt;</Text>
        <Text color={brand.bright}>MewCode v0.1.0</Text>
        <Text color={brand.muted}>{selectedProvider.name} {symbols.separator} {selectedProvider.model} {symbols.separator} {workDir}</Text>
      </Box>
      <Static items={committed}>{(message, index) => <CommittedMessage key={index} message={message} />}</Static>
      <ChatView messages={active} streamingText={isStreaming ? streamingText : undefined} />
      {isStreaming ? <Spinner inputTokens={inputTokens} outputTokens={outputTokens} /> : completionMark ? <Text color={brand.success}>{symbols.success} {completionMark}</Text> : null}
      {error ? <Text color={brand.error}>{symbols.error} {error}</Text> : null}
      <InputBox onSubmit={handleSubmit} disabled={isStreaming} history={promptHistory} />
      <StatusBar model={selectedProvider.model} inputTokens={inputTokens} outputTokens={outputTokens} />
    </Box>
  );
}
