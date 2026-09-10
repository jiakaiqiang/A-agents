import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { HookConfig, MCPServerConfig, ProviderConfig } from "../config/config.js";
import { getContextWindowAsync } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { ModeTracker } from "../prompt/reminder.js";
import type { AgentMode, LoopPhase } from "../agent/events.js";
import { runLoop } from "../agent/loop.js";
import { appendLocalRule, loadPermissionConfig } from "../permission/config.js";
import { nextPermissionMode } from "../permission/limits.js";
import type { ConfirmChoice, ConfirmRequest, PermissionGate, PermissionMode, Rule } from "../permission/types.js";
import { createDefaultRegistry } from "../tools/index.js";
import { Banner, ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { ConfirmBox } from "./confirm.js";
import { InputBox } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { brand, symbols } from "./styles.js";
import { randomCompletionVerb } from "./verbs.js";

type AppState = "providerSelect" | "chat";

/** 静态区的两类条目：启动横幅只有一条，其余是已定稿的对话消息。 */
type StaticItem =
  | { kind: "banner" }
  | { kind: "message"; message: ChatMessage };

/** 流式正文只在动态区显示末尾几行，避免撑破终端高度触发 Ink 清屏。 */
const STREAM_TAIL_LINES = 8;

/**
 * 四档的展示名、对应的提示词模式与档位语义说明。
 * 收成一张表：斜杠命令与 Shift+Tab 走同一份定义，避免两处各写一遍导致语义漂移。
 * hint 不再往对话里弹（切档反馈只看状态栏），留在这里作为各档语义的唯一说明处。
 */
const MODE_INFO: Record<PermissionMode, { label: string; agentMode: AgentMode; hint: string }> = {
  plan: {
    label: "计划",
    agentMode: "plan",
    hint: "计划档：模型会先产出计划，改文件与执行命令每次都会请你确认。",
  },
  default: {
    label: "默认",
    agentMode: "execute",
    hint: "默认档：改文件与执行命令需要你逐次确认。",
  },
  acceptEdits: {
    label: "接受编辑",
    agentMode: "execute",
    hint: "接受编辑档：改文件自动放行，执行命令仍需确认。",
  },
  bypass: {
    label: "放行",
    agentMode: "execute",
    hint: "放行档：工具调用不再询问。危险命令黑名单与路径沙箱仍然生效，不可放开。",
  },
};

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
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const [cacheCreationTokens, setCacheCreationTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [mode, setMode] = useState<AgentMode>("execute");
  const [iteration, setIteration] = useState(0);
  const [phase, setPhase] = useState<LoopPhase>("model");
  const permissionConfigRef = useRef(loadPermissionConfig());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(permissionConfigRef.current.mode);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null);

  const clientRef = useRef<LLMClient | null>(null);
  const registryRef = useRef(createDefaultRegistry());
  const conversationRef = useRef(new ConversationManager());
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef("");
  const committedIndexRef = useRef(0);
  // 已收到结果摘要的工具行；未结束的工具行留在动态区，方便原地补摘要。
  const completedToolIdsRef = useRef(new Set<string>());
  // 轮次计数要跨轮存活，所以放在 ref 里：runLoop 每轮新建，计数会跟着丢。
  const modeTrackerRef = useRef(new ModeTracker());
  // 规则集要跨轮累积（会话级放行写在这里），且 Gate 每轮重建时要读到最新值。
  const rulesRef = useRef(permissionConfigRef.current.rules);
  // 档位也走 ref：Gate 里读 state 会被闭包捕获成旧值，切档后当前轮仍按旧档判定（权限 spec F16）。
  const permissionModeRef = useRef<PermissionMode>(permissionConfigRef.current.mode);
  // 挂起的确认 Promise 的 resolve；Esc 中断时必须兑付，否则 runLoop 收不了尾。
  const confirmResolveRef = useRef<((choice: ConfirmChoice) => void) | null>(null);
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

  /** 兑付挂起的确认，并清掉确认框。中断与正常选择都走这里。 */
  function settleConfirm(choice: ConfirmChoice): void {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setPendingConfirm(null);
    resolve?.(choice);
  }

  /**
   * 权限确认回调：Promise 挂起到用户按键为止（权限 spec F20）。
   * 只会在串行批里被调用，所以同一时刻最多一个确认框。
   */
  function requestConfirm(request: ConfirmRequest): Promise<ConfirmChoice> {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setPendingConfirm(request);
    });
  }

  /**
   * 档位与规则都从 ref 读，避免闭包捕获旧值（权限 spec F16）。
   * mode 用 getter：Shift+Tab 可能在本轮跑到一半时按下，快照会让剩余调用仍按旧档判定。
   */
  function buildGate(): PermissionGate {
    return {
      get mode() { return permissionModeRef.current; },
      rules: rulesRef.current,
      confirm: requestConfirm,
      grantSession(rule: Rule) {
        rulesRef.current.layers.session.push(rule);
      },
      grantAlways(rule: Rule) {
        appendLocalRule(rule, workDir);
        // 同时写进内存层：本进程立即生效，不重读配置文件。
        rulesRef.current.layers.local.push(rule);
      },
    };
  }

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      abortControllerRef.current?.abort();
      exit();
      return;
    }
    // Shift+Tab 循环切档（权限 spec F16）。确认框弹出时不切：那时按键属于确认框，
    // 且档位已被那次调用读走，切了也不影响它，只会让人误以为选择被改了。
    if (key.tab && key.shift && !pendingConfirm) {
      switchPermissionMode(nextPermissionMode(permissionModeRef.current));
      return;
    }
    // Esc 只取消本轮，会话保持可用（spec F7）。
    if (key.escape && isStreaming) {
      // 有挂起的确认时先按拒绝兑付，否则 Promise 永久悬空、runLoop 无法收尾。
      if (confirmResolveRef.current) settleConfirm("deny");
      abortControllerRef.current?.abort();
    }
  });

  // 权限配置的解析告警在启动时呈现一次，不静默放开（权限 spec N5）。
  useEffect(() => {
    const warnings = permissionConfigRef.current.warnings;
    if (warnings.length === 0) return;
    setMessages((previous) => {
      const next: ChatMessage[] = [
        ...previous,
        ...warnings.map((text) => ({ role: "system" as const, content: `权限配置：${text}`, isError: true })),
      ];
      advanceCommit(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (appState !== "chat" || !selectedProvider) return;
    let cancelled = false;
    // 提示词里始终列全量工具：随模式增删会改变稳定段字节，切一次模式就废掉整个缓存前缀。
    const toolSummaries = registryRef.current.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
    const segments = buildSystemPrompt(
      detectEnvironment(workDir, selectedProvider.model),
      { tools: toolSummaries },
    );
    clientRef.current = null;
    void createClient(selectedProvider, segments)
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
        permission: buildGate(),
        signal: abortControllerRef.current?.signal,
        // 本轮的模式指令：首轮完整、间隔轮次重复、其余精简（spec F17–F19）。
        reminders: modeTrackerRef.current.nextTurn(),
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
            setCacheReadTokens(event.usage.cacheReadInputTokens);
            setCacheCreationTokens(event.usage.cacheCreationInputTokens);
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

  /**
   * 切档：斜杠命令与 Shift+Tab 的唯一入口。
   * 档位决定提示词模式（权限 spec F18），所以两者一起定，不单独设 AgentMode。
   * 不往对话里写提示：反馈只靠状态栏左侧的档位字样。
   */
  function switchPermissionMode(nextPermission: PermissionMode): void {
    const info = MODE_INFO[nextPermission];
    // 纯模式开关：不写会话历史、不发模型请求（spec F25）。
    setMode(info.agentMode);
    setPermissionMode(nextPermission);
    // ref 与 state 同写：Gate 从 ref 读档位，流式期间切档也能立刻生效（权限 spec F16）。
    permissionModeRef.current = nextPermission;
    // 计数归零，切过去的下一轮重新发完整版模式指令。
    modeTrackerRef.current.setMode(info.agentMode);
    setCompletionMark("");
    setError(null);
  }

  function handleSubmit(text: string): void {
    if (isStreaming) return;
    if (text === "/exit") {
      exit();
      return;
    }
    if (text === "/plan") {
      switchPermissionMode("plan");
      return;
    }
    if (text === "/do") {
      switchPermissionMode("default");
      return;
    }
    if (text === "/accept-edits") {
      switchPermissionMode("acceptEdits");
      return;
    }
    if (text === "/bypass") {
      switchPermissionMode("bypass");
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
  // banner 与已定稿消息同走静态区：Static 一次写出后不再重绘，
  // 嵌在带 padding 的容器里会被父容器的布局重绘覆盖掉。
  const staticItems: StaticItem[] = [
    { kind: "banner" },
    ...committed.map((message) => ({ kind: "message" as const, message })),
  ];
  return (
    <>
      <Static items={staticItems}>
        {(item, index) => item.kind === "banner"
          ? <Banner key="banner" providerName={selectedProvider.name} model={selectedProvider.model} workDir={workDir} />
          : <CommittedMessage key={index} message={item.message} />}
      </Static>
      <Box flexDirection="column" paddingX={1}>
      <ChatView
        messages={pending}
        streamingText={isStreaming && streamingText ? tailLines(streamingText, STREAM_TAIL_LINES) : undefined}
      />
      {isStreaming ? <Spinner inputTokens={inputTokens} outputTokens={outputTokens} iteration={iteration} phase={phase} /> : completionMark ? <Text color={brand.success}>{symbols.success} {completionMark}</Text> : null}
      {error ? <Text color={brand.error}>{symbols.error} {error}</Text> : null}
      {/* 确认框与输入框互斥：同时挂载会让两个 useInput 争抢同一批按键。 */}
      {pendingConfirm
        ? <ConfirmBox request={pendingConfirm} onChoose={settleConfirm} />
        : <InputBox onSubmit={handleSubmit} disabled={isStreaming} history={promptHistory} />}
      <StatusBar
        model={selectedProvider.model}
        mode={MODE_INFO[permissionMode].label}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
        cacheReadTokens={cacheReadTokens}
        cacheCreationTokens={cacheCreationTokens}
      />
      </Box>
    </>
  );
}
