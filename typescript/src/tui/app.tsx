import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { HookConfig, MCPServerConfig, ProviderConfig } from "../config/config.js";
import { getContextWindowAsync } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import type { AgentMode, LoopPhase } from "../agent/events.js";
import { runLoop } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { InputBox } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { brand, symbols } from "./styles.js";
import { randomCompletionVerb } from "./verbs.js";

type AppState = "providerSelect" | "chat";

/** 流式正文只在动态区显示末尾几行，避免撑破终端高度触发 Ink 清屏。 */
const STREAM_TAIL_LINES = 8;

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

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
  const [mode, setMode] = useState<AgentMode>("execute");
  const [iteration, setIteration] = useState(0);
  const [phase, setPhase] = useState<LoopPhase>("model");

  const clientRef = useRef<LLMClient | null>(null);
  const registryRef = useRef(createDefaultRegistry());
  const conversationRef = useRef(new ConversationManager());
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef("");
  const committedIndexRef = useRef(0);
  // 已收到结果摘要的工具行；未结束的工具行留在动态区，方便原地补摘要。
  const completedToolIdsRef = useRef(new Set<string>());
  const workDir = process.cwd();

  /**
   * 把 committed 边界推进到连续定稿前缀的末尾。
   * Static 每次只写出新增项；一次性从 0 跳到 N 会在活动区收缩时丢掉尾行。
   */
  function advanceCommit(current: ChatMessage[]): void {
    let index = committedIndexRef.current;
    while (index < current.length) {
      const item = current[index]!;
      if (item.role === "tool_use" && item.toolId && !completedToolIdsRef.current.has(item.toolId)) break;
      index += 1;
    }
    committedIndexRef.current = index;
  }

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      abortControllerRef.current?.abort();
      exit();
      return;
    }
    // Esc 只取消本轮，会话保持可用（spec F7）。
    if (key.escape && isStreaming) {
      abortControllerRef.current?.abort();
    }
  });

  useEffect(() => {
    if (appState !== "chat" || !selectedProvider) return;
    let cancelled = false;
    // 计划模式只把只读工具写进提示词，与实际下发的工具定义保持一致。
    const available = mode === "plan" ? registryRef.current.listReadOnly() : registryRef.current.list();
    const toolSummaries = available.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
    const systemPrompt = buildSystemPrompt(
      detectEnvironment(workDir, selectedProvider.model),
      { tools: toolSummaries, mode },
    );
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
  }, [appState, selectedProvider, workDir, mode]);

  async function runAgentLoop(): Promise<void> {
    const client = clientRef.current;
    if (!client) {
      setError("正在初始化 LLM 客户端，请稍后重试。");
      setIsStreaming(false);
      return;
    }

    let buffer = "";
    let flushedAny = false;
    // 每次迭代的正文各自落成一条消息，避免被下一次迭代的流式文本覆盖（spec F28）。
    function flushBuffer(): void {
      if (!buffer) return;
      const text = buffer;
      buffer = "";
      flushedAny = true;
      streamingTextRef.current = "";
      setStreamingText("");
      setMessages((previous) => {
        const next: ChatMessage[] = [...previous, { role: "assistant", content: text }];
        advanceCommit(next);
        return next;
      });
    }

    try {
      for await (const event of runLoop({
        client,
        conversation: conversationRef.current,
        registry: registryRef.current,
        protocol: selectedProvider.protocol,
        workDir,
        mode,
        signal: abortControllerRef.current?.signal,
      })) {
        switch (event.type) {
          case "text":
            buffer += event.text;
            streamingTextRef.current = buffer;
            setStreamingText(buffer);
            break;
          case "thinking":
            // 思考增量本期不渲染。
            break;
          case "progress":
            if (event.phase === "tools") flushBuffer();
            setIteration(event.iteration);
            setPhase(event.phase);
            break;
          case "tool_start":
            // 工具行先出现，执行结束后按 toolId 原地补摘要。
            setMessages((previous) => [...previous, {
              role: "tool_use",
              toolId: event.toolId,
              content: `${symbols.dot} ${event.argSummary}`,
            }]);
            break;
          case "tool_end":
            completedToolIdsRef.current.add(event.toolId);
            setMessages((previous) => {
              const next = previous.map((message) => message.toolId === event.toolId
                ? { ...message, content: `${message.content} — ${event.summary}`, isError: !event.ok }
                : message);
              advanceCommit(next);
              return next;
            });
            break;
          case "usage":
            setInputTokens(event.usage.inputTokens);
            setOutputTokens(event.usage.outputTokens);
            break;
          case "notice":
            setMessages((previous) => {
              const next: ChatMessage[] = [...previous, { role: "system", content: event.text, isError: event.isError }];
              advanceCommit(next);
              return next;
            });
            break;
          case "done":
            flushBuffer();
            if (event.reason === "complete") {
              if (flushedAny || event.toolsExecuted > 0) setCompletionMark(randomCompletionVerb());
              else setError("模型返回了空内容，请检查 provider 协议、端点地址和模型名称。");
            } else if (event.reason === "stream_error") {
              setError(event.errorMessage ?? "请求失败");
            }
            // 其余停止原因已由 notice 事件呈现，不重复提示。
            setMessages((previous) => {
              advanceCommit(previous);
              return previous;
            });
            break;
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      setError(message);
    } finally {
      setIsStreaming(false);
      setStreamingText("");
      streamingTextRef.current = "";
      setIteration(0);
      abortControllerRef.current = null;
    }
  }

  function switchMode(next: AgentMode, hint: string): void {
    // 纯模式开关：不写会话历史、不发模型请求，生效于用户的下一条消息（spec F25）。
    setMode(next);
    setCompletionMark("");
    setError(null);
    setMessages((previous) => {
      const next: ChatMessage[] = [...previous, { role: "system", content: hint }];
      advanceCommit(next);
      return next;
    });
  }

  function handleSubmit(text: string): void {
    if (isStreaming) return;
    if (text === "/exit") {
      exit();
      return;
    }
    if (text === "/plan") {
      switchMode("plan", "已切换到计划模式：仅只读工具可用，模型会先产出计划。");
      return;
    }
    if (text === "/do") {
      switchMode("execute", "已切换到执行模式：全部工具可用。");
      return;
    }

    setPromptHistory((previous) => [...previous, text]);
    setMessages((previous) => {
      const next: ChatMessage[] = [...previous, { role: "user", content: text }];
      advanceCommit(next);
      return next;
    });
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
  const pending = messages.slice(committedIndexRef.current);
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
      <ChatView
        messages={pending}
        streamingText={isStreaming && streamingText ? tailLines(streamingText, STREAM_TAIL_LINES) : undefined}
      />
      {isStreaming ? <Spinner inputTokens={inputTokens} outputTokens={outputTokens} iteration={iteration} phase={phase} /> : completionMark ? <Text color={brand.success}>{symbols.success} {completionMark}</Text> : null}
      {error ? <Text color={brand.error}>{symbols.error} {error}</Text> : null}
      <InputBox onSubmit={handleSubmit} disabled={isStreaming} history={promptHistory} />
      <StatusBar model={selectedProvider.model} mode={mode === "plan" ? "计划" : "执行"} inputTokens={inputTokens} outputTokens={outputTokens} />
    </Box>
  );
}
