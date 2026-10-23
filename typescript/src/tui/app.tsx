import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextManagementConfig, HookConfig, ProviderConfig } from "../config/config.js";
import { getContextWindowAsync } from "../config/config.js";
import type { McpServerReport } from "../mcp/types.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { getContextWindow } from "../config/config.js";
import { Compactor, resolveCompactionSettings } from "../context/compactor.js";
import { TokenEstimator } from "../context/tokens.js";
import { buildSystemPrompt, detectEnvironment, type SystemPromptSegments } from "../prompt/builder.js";
import { ModeTracker } from "../prompt/reminder.js";
import type { AgentEvent, AgentMode, LoopPhase } from "../agent/events.js";
import { runLoop } from "../agent/loop.js";
import { appendLocalRule, loadPermissionConfig } from "../permission/config.js";
import { nextPermissionMode } from "../permission/limits.js";
import type { ConfirmChoice, ConfirmRequest, PermissionGate, PermissionMode, Rule } from "../permission/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Banner, ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { ConfirmBox } from "./confirm.js";
import { InputBox } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { brand, symbols } from "./styles.js";
import { randomCompletionVerb } from "./verbs.js";
import { MemoryStore, memoryDir, type NoteScope } from "../memory/notes.js";
import { listSessions, newSessionId, SessionWriter, sessionsDir, type SessionInfo } from "../memory/session.js";
import { resumeSession } from "../memory/resume.js";
import { MemoryUpdater, TurnCollector } from "../memory/updater.js";
import { SessionSelect } from "./session-select.js";
import { sessionLockPath, tryAcquire, type Release } from "../memory/lock.js";
import { createBuiltinRegistry } from "../commands/builtins/index.js";
import { suggest } from "../commands/completion.js";
import { dispatch } from "../commands/dispatcher.js";
import { MODE_TAGS } from "../commands/format.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { CommandUI } from "../commands/types.js";
import { skillCatalogSection } from "../skills/catalog.js";
import { resultMessage, runIsolatedSkill } from "../skills/isolated.js";
import { SkillManager } from "../skills/manager.js";
import type { IsolatedOutcome, SkillDef } from "../skills/types.js";
import type { ToolContext } from "../tools/types.js";

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
    label: MODE_TAGS.plan,
    agentMode: "plan",
    hint: "计划档：模型会先产出计划，改文件与执行命令每次都会请你确认。",
  },
  default: {
    label: MODE_TAGS.default,
    agentMode: "execute",
    hint: "默认档：改文件与执行命令需要你逐次确认。",
  },
  acceptEdits: {
    label: MODE_TAGS.acceptEdits,
    agentMode: "execute",
    hint: "接受编辑档：改文件自动放行，执行命令仍需确认。",
  },
  bypass: {
    label: MODE_TAGS.bypass,
    agentMode: "execute",
    hint: "放行档：工具调用不再询问。危险命令黑名单与路径沙箱仍然生效，不可放开。",
  },
};

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

/** MCP 连接报告的一行文案：四态可区分（spec F16、AC15）。 */
export function mcpReportText(report: McpServerReport): string {
  switch (report.status) {
    case "ok":
      return `MCP ${report.name}：已注册 ${report.toolCount} 个工具（${report.tools.join(", ")}）`;
    case "disabled":
      return `MCP ${report.name}：已配置为禁用，未连接`;
    case "timeout":
      return `MCP ${report.name}：连接超时（${report.timeoutMs}ms），本次未接入，其余功能不受影响`;
    case "failed":
      return `MCP ${report.name}：连接失败——${report.reason}`;
  }
}

export function App({
  providers,
  hooks: _hooks,
  registry,
  mcpReports = [],
  contextManagement = {},
  startup = { instructions: "", memory: "", warnings: [] },
  workDir = process.cwd(),
  homeDir = homedir(),
  commands,
  skills,
  skillReport = { warnings: [], summary: "" },
}: {
  providers: ProviderConfig[];
  hooks: HookConfig[];
  registry: ToolRegistry;
  commands?: CommandRegistry;
  skills?: SkillManager;
  skillReport?: { warnings: string[]; summary: string };
  mcpReports?: McpServerReport[];
  contextManagement?: ContextManagementConfig;
  startup?: { instructions: string; memory: string; warnings: string[] };
  workDir?: string;
  homeDir?: string;
}) {
  const { exit } = useApp();
  const { write: writeStdout } = useStdout();
  // main 在启动期构造并检查冲突后传入；测试与 fixture 不传时用内置命令兜底。
  const fallbackCommandsRef = useRef<CommandRegistry | null>(null);
  const commandRegistry = commands ?? (fallbackCommandsRef.current ??= createBuiltinRegistry());
  // main 在 MCP 连接后装配好 Skill 传入；测试与 fixture 不传时用空集合兜底，行为与接入前一致。
  const fallbackSkillsRef = useRef<SkillManager | null>(null);
  const skillManager = skills ?? (fallbackSkillsRef.current ??= new SkillManager([]));
  const segmentsRef = useRef<SystemPromptSegments | null>(null);
  // 补全列表是否可见：InputBox 渲染期写入，Esc 中断判断先读它（斜杠命令 spec F10）。
  const suggestionsOpenRef = useRef(false);
  const [staticKey, setStaticKey] = useState(0);
  const [, setStatusTick] = useState(0);
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
  // 独立 Skill 运行器在工具执行期间被调用，此时组件可能已重渲染；从 ref 读当前模式（Skill spec F11）。
  const modeRef = useRef<AgentMode>("execute");
  modeRef.current = mode;
  const [iteration, setIteration] = useState(0);
  const [phase, setPhase] = useState<LoopPhase>("model");
  const permissionConfigRef = useRef(loadPermissionConfig(workDir));
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(permissionConfigRef.current.mode);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null);
  const [resumeList, setResumeList] = useState<SessionInfo[] | null>(null);
  const [isMaintaining, setIsMaintaining] = useState(false);
  const startupRef = useRef(startup);
  const pendingResumeRef = useRef<SessionInfo[] | null>(null);
  const activityRef = useRef<"idle" | "agent" | "maintenance">("idle");
  const memoryUpdaterRef = useRef<MemoryUpdater | null>(null);
  const sessionWriterRef = useRef<SessionWriter | null>(null);
  // 当前会话的跨进程占用（F15）：随「当前是哪个会话」切换，不放在 SessionWriter 里。
  const sessionReleaseRef = useRef<Release | null>(null);

  const clientRef = useRef<LLMClient | null>(null);
  const compactorRef = useRef<Compactor | null>(null);
  const registryRef = useRef(registry);
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
  const compactionSettings = resolveCompactionSettings(contextManagement);

  function addNotice(content: string, isError = false): void {
    setMessages((previous) => {
      const next: ChatMessage[] = [...previous, { role: "system", content, isError }];
      advanceCommit(next);
      return next;
    });
  }

  function createWriter(id: string): SessionWriter {
    return new SessionWriter(id, workDir, (message) => addNotice(`会话存档写入失败：${message}，本会话不再存档`, true));
  }

  /** 开一个新会话存档并换占用：启动与 /clear 共用。 */
  function startNewSession(): string {
    const id = newSessionId(new Date(), (candidate) => existsSync(join(workDir, ".mewcode", "sessions", `${candidate}.jsonl`)));
    sessionWriterRef.current = createWriter(id);
    conversationRef.current.setRecorder(sessionWriterRef.current);
    // 新会话即占用（F15）；新 ID 不会被占，失败只是不占用，不影响存档。
    sessionReleaseRef.current?.();
    sessionReleaseRef.current = tryAcquire(sessionLockPath(workDir, id));
    return id;
  }

  if (!sessionWriterRef.current) startNewSession();

  // 退出（含 /exit、Ctrl+C）与卸载时释放会话占用；强杀留下的锁由 pid 存活检测识别为残留。
  useEffect(() => {
    const release = () => sessionReleaseRef.current?.();
    process.on("exit", release);
    return () => {
      process.off("exit", release);
      release();
    };
  }, []);

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
      memoryUpdaterRef.current?.abort();
      if (confirmResolveRef.current) settleConfirm("deny");
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
    // 补全列表打开时 Esc 只收起列表（由 InputBox 处理），不中断本轮。
    if (key.escape && isStreaming && !suggestionsOpenRef.current) {
      // 有挂起的确认时先按拒绝兑付，否则 Promise 永久悬空、runLoop 无法收尾。
      if (confirmResolveRef.current) settleConfirm("deny");
      abortControllerRef.current?.abort();
    }
  });

  // 权限配置的解析告警在启动时呈现一次，不静默放开（权限 spec N5）。
  useEffect(() => {
    const warnings = permissionConfigRef.current.warnings;
    // MCP 连接报告是启动期一次性数据，与告警同批呈现（spec F16）。
    const mcpMessages = mcpReports.map((report) => ({
      role: "system" as const,
      content: mcpReportText(report),
      isError: report.status === "failed" || report.status === "timeout",
    }));
    // Skill 加载告警与摘要同批呈现（Skill spec F14）。
    const skillMessages: ChatMessage[] = [
      ...skillReport.warnings.map((text) => ({ role: "system" as const, content: `Skill：${text}`, isError: true })),
      ...(skillReport.summary ? [{ role: "system" as const, content: skillReport.summary }] : []),
    ];
    if (warnings.length === 0 && mcpMessages.length === 0 && startupRef.current.warnings.length === 0 && skillMessages.length === 0) return;
    setMessages((previous) => {
      const next: ChatMessage[] = [
        ...previous,
        ...warnings.map((text) => ({ role: "system" as const, content: `权限配置：${text}`, isError: true })),
        ...mcpMessages,
        ...startupRef.current.warnings.map((text) => ({ role: "system" as const, content: `启动记忆：${text}`, isError: true })),
        ...skillMessages,
      ];
      advanceCommit(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mcpReports 是启动期一次性数据
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
      {
        tools: toolSummaries,
        customInstructions: startupRef.current.instructions,
        memory: startupRef.current.memory,
        // Skill 目录会话内不变，进稳定段（Skill spec F6、N2）。
        skills: skillCatalogSection(skillManager.list()),
      },
    );
    // 独立 Skill 指定 model 时要用同一份提示词另建客户端（Skill plan「App 接入要点」）。
    segmentsRef.current = segments;
    clientRef.current = null;
    memoryUpdaterRef.current?.abort();
    void createClient(selectedProvider, segments)
      .then((client) => {
        if (!cancelled) {
          clientRef.current = client;
          memoryUpdaterRef.current = new MemoryUpdater(client, {
            user: new MemoryStore(memoryDir("user", workDir, homeDir)),
            project: new MemoryStore(memoryDir("project", workDir, homeDir)),
          }, (names) => addNotice(`已更新记忆：${names.join("、")}`));
          // Compactor 跨轮持有熔断计数与估算锚点，随 client 一起就绪（上下文 spec F6）。
          compactorRef.current = new Compactor(
            client,
            conversationRef.current,
            new TokenEstimator(),
            workDir,
            getContextWindow(selectedProvider),
            compactionSettings,
          );
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    void getContextWindowAsync(selectedProvider).catch(() => undefined);
    return () => {
      cancelled = true;
      memoryUpdaterRef.current?.abort();
      abortControllerRef.current?.abort();
      confirmResolveRef.current?.("deny");
      confirmResolveRef.current = null;
    };
  }, [appState, selectedProvider, workDir]);

  /**
   * /compact 手动压缩（上下文 spec F13/F14）：无阈值直接压；
   * 压后剩余 <3K 提示异常；熔断中成功则解除熔断并提示恢复。
   */
  async function handleCompact(): Promise<void> {
    const compactor = compactorRef.current;
    if (!compactor) {
      setError("LLM 客户端尚未就绪，无法压缩。");
      return;
    }
    const wasCircuitOpen = compactor.circuitOpen;
    if (wasCircuitOpen) {
      setMessages((previous) => [...previous, { role: "system", content: "压缩连续失败中，正在重试手动压缩……" }]);
    }
    const result = await compactor.compactManually();
    if (result.error) {
      const suffix = result.circuitOpen ? "；已连续失败 3 次，自动压缩暂停（再次 /compact 成功后恢复）" : "";
      setError(`压缩失败：${result.error}${suffix}`);
      return;
    }
    if (!result.compacted) {
      setMessages((previous) => [...previous, { role: "system", content: "当前历史不足以压缩。" }]);
      return;
    }
    const parts = [
      `上下文已从约 ${result.beforeTokens ?? "?"} tokens 压缩到约 ${result.afterTokens ?? "?"} tokens；已压缩历史：${result.summaryMessageCount} 条消息 → 摘要 + 近期 ${result.recentCount} 条原文`,
      `摘要内容：\n${result.summary ?? "（摘要内容为空）"}`,
    ];
    if (compactor.remainingTokens() < compactionSettings.manualMarginTokens) {
      parts.push("警告：压缩后剩余空间不足 3K tokens，下一次请求可能仍超限。");
    }
    if (wasCircuitOpen && !compactor.circuitOpen) {
      parts.push("自动压缩已恢复。");
    }
    setMessages((previous) => {
      const next: ChatMessage[] = [...previous, { role: "system", content: parts.join(" ") }];
      advanceCommit(next);
      return next;
    });
  }

  async function runAgentLoop(userText: string): Promise<void> {
    const client = clientRef.current;
    if (!client) {
      setError("正在初始化 LLM 客户端，请稍后重试。");
      setIsStreaming(false);
      activityRef.current = "idle";
      return;
    }

    const collector = new TurnCollector(userText);
    const updater = memoryUpdaterRef.current;
    const renderer = createEventRenderer();

    try {
      for await (const event of runLoop({
        client,
        conversation: conversationRef.current,
        registry: registryRef.current,
        protocol: selectedProvider.protocol,
        workDir,
        mode,
        permission: buildGate(),
        compactor: compactorRef.current ?? undefined,
        signal: abortControllerRef.current?.signal,
        // 本轮的模式指令：首轮完整、间隔轮次重复、其余精简（spec F17–F19）。
        reminders: modeTrackerRef.current.nextTurn(),
        // 已激活 Skill 的钉住指令与工具白名单，每次迭代读一次（Skill spec F8、F10）。
        skills: skillManager,
      })) {
        collector.observe(event);
        if (event.type !== "done") {
          renderer.render(event);
          continue;
        }
        renderer.flush();
        if (event.reason === "complete") {
          if (renderer.flushedAny() || event.toolsExecuted > 0) setCompletionMark(randomCompletionVerb());
          else setError("模型返回了空内容，请检查 provider 协议、端点地址和模型名称。");
        } else if (event.reason === "stream_error") {
          setError(event.errorMessage ?? "请求失败");
        }
        // 其余停止原因已由 notice 事件呈现，不重复提示。
        setMessages((previous) => {
          advanceCommit(previous);
          return previous;
        });
      }
      const digest = collector.digest();
      if (digest && !abortControllerRef.current?.signal.aborted) updater?.enqueue(digest);
    } catch (cause) {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      setError(message);
    } finally {
      finishTurn();
    }
  }

  /**
   * 事件渲染器：主循环与独立 Skill 子对话共用（Skill plan「App 接入要点」）。
   * 子对话传 prefix（如 "[test] "）给工具行与提示加前缀；它的正文不流式显示（结果单独回流），也不更新状态栏 Token。
   */
  function createEventRenderer(prefix = "", options: { streamText?: boolean; updateUsage?: boolean } = {}) {
    const streamText = options.streamText ?? true;
    const updateUsage = options.updateUsage ?? true;
    let buffer = "";
    let flushedAny = false;
    // 每次迭代的正文各自落成一条消息，避免被下一次迭代的流式文本覆盖（spec F28）。
    function flush(): void {
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
    function render(event: Exclude<AgentEvent, { type: "done" }>): void {
      switch (event.type) {
        case "text":
          if (!streamText) break;
          buffer += event.text;
          streamingTextRef.current = buffer;
          setStreamingText(buffer);
          break;
        case "thinking":
          // 思考增量本期不渲染。
          break;
        case "progress":
          if (event.phase === "tools") flush();
          setIteration(event.iteration);
          setPhase(event.phase);
          break;
        case "tool_start":
          // 工具行先出现，执行结束后按 toolId 原地补摘要。
          setMessages((previous) => [...previous, {
            role: "tool_use",
            toolId: event.toolId,
            content: `${prefix}${symbols.dot} ${event.argSummary}`,
          }]);
          break;
        case "tool_end":
          setMessages((previous) => {
            const next = previous.map((message) => message.toolId === event.toolId
              ? { ...message, content: `${message.content} — ${event.summary}`, isError: !event.ok }
              : message);
            advanceCommit(next);
            return next;
          });
          break;
        case "tool_output":
          completedToolIdsRef.current.add(event.toolId);
          setMessages((previous) => {
            const next = previous.map((message) => message.toolId === event.toolId && event.content
              ? { ...message, content: `${message.content}\n${event.content}` }
              : message);
            advanceCommit(next);
            return next;
          });
          break;
        case "usage":
          if (!updateUsage) break;
          setInputTokens(event.usage.inputTokens);
          setOutputTokens(event.usage.outputTokens);
          setCacheReadTokens(event.usage.cacheReadInputTokens);
          setCacheCreationTokens(event.usage.cacheCreationInputTokens);
          break;
        case "notice":
          setMessages((previous) => {
            const next: ChatMessage[] = [...previous, { role: "system", content: `${prefix}${event.text}`, isError: event.isError }];
            advanceCommit(next);
            return next;
          });
          break;
        case "compaction":
          // 压缩提示与 notice 同路径渲染（上下文 spec F15）。
          setMessages((previous) => {
            const next: ChatMessage[] = [...previous, { role: "system", content: `${prefix}${event.text}` }];
            advanceCommit(next);
            return next;
          });
          break;
      }
    }
    return { render, flush, flushedAny: () => flushedAny };
  }

  /** 一轮结束后的界面收尾：主循环与独立 Skill 轮共用。 */
  function finishTurn(): void {
    setIsStreaming(false);
    setStreamingText("");
    streamingTextRef.current = "";
    setIteration(0);
    abortControllerRef.current = null;
    activityRef.current = "idle";
    if (pendingResumeRef.current) {
      setResumeList(pendingResumeRef.current);
      pendingResumeRef.current = null;
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

  async function handleResume(id: string): Promise<void> {
    if (!clientRef.current || activityRef.current !== "idle") {
      setError("LLM 客户端尚未就绪或历史正在更新，请稍后重试。");
      return;
    }
    activityRef.current = "maintenance";
    setIsMaintaining(true);
    setResumeList(null);
    setError(null);
    setCompletionMark("");
    try {
      // 先占用目标会话再放开当前会话（F15）：抢不到说明另一实例正在续写，恢复会让两条历史交错写进同一文件。
      const release = tryAcquire(sessionLockPath(workDir, id));
      if (!release) {
        addNotice("该会话正在被另一个 MewCode 使用", true);
        return;
      }
      const writer = createWriter(id);
      let outcome;
      try {
        outcome = await resumeSession({
          workDir, id, conversation: conversationRef.current, writer,
          compactor: compactorRef.current ?? undefined,
        });
      } catch (cause) {
        release();
        throw cause;
      }
      sessionReleaseRef.current?.();
      sessionReleaseRef.current = release;
      sessionWriterRef.current = writer;
      const parts = [`已恢复会话 ${id}：${outcome.messageCount} 条消息`];
      if (outcome.skippedLines) parts.push(`跳过 ${outcome.skippedLines} 行损坏记录`);
      if (outcome.truncated) parts.push("未完成或不配对的工具调用已截断");
      if (outcome.compaction === "done") parts.push("已先压缩一次");
      if (outcome.compaction === "failed") parts.push("压缩失败，后续由自动压缩接管");
      if (outcome.gapReminder) parts.push(`已提醒模型：${outcome.gapReminder}`);
      setMessages((previous) => {
        const next: ChatMessage[] = [
          ...previous, { role: "system", content: `──── 已恢复会话 ${id} ────` },
          ...outcome.display, { role: "system", content: parts.join("；") },
        ];
        advanceCommit(next);
        return next;
      });
      setInputTokens(0);
      setOutputTokens(0);
      setCacheReadTokens(0);
      setCacheCreationTokens(0);
      modeTrackerRef.current.setMode(mode);
      // 激活状态不存档：恢复后的会话从无激活 Skill 开始（Skill spec F12）。
      skillManager.deactivate();
    } catch (cause) {
      setError(`恢复失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      activityRef.current = "idle";
      setIsMaintaining(false);
    }
  }

  /**
   * 发起一轮 Agent：对话区显示 display，模型收到 prompt（斜杠命令 spec F5）。
   * 普通消息两者相同；提示词命令 display 是原命令、prompt 是展开文本。
   */
  function startAgentTurn(display: string, prompt: string): boolean {
    if (!clientRef.current) {
      setError("正在初始化 LLM 客户端，请稍后重试。");
      return false;
    }

    setMessages((previous) => {
      const next: ChatMessage[] = [...previous, { role: "user", content: display }];
      advanceCommit(next);
      return next;
    });
    conversationRef.current.addUserMessage(prompt, display);
    setCompletionMark("");
    setError(null);
    setStreamingText("");
    setIsStreaming(true);
    activityRef.current = "agent";
    abortControllerRef.current = new AbortController();
    void runAgentLoop(prompt);
    return true;
  }

  /**
   * 斜杠调用 Skill（Skill spec F9、F11）：共享模式先钉住再发一条简短触发语；独立模式跑子对话。
   * 返回 false 表示客户端未就绪，命令层据此提示并保留输入。
   */
  function invokeSkill(name: string, args: string, display: string): boolean {
    const skill = skillManager.get(name);
    if (!skill) {
      addNotice(`未找到 Skill ${name}`, true);
      return true;
    }
    if (!clientRef.current) return false;
    if (skill.mode === "isolated") return runIsolatedTurn(skill, args, display);
    skillManager.activate(name, args);
    return startAgentTurn(display, args ? `执行 Skill ${name}，参数：${args}` : `执行 Skill ${name}`);
  }

  /** 独立子对话用的客户端：写了 model 时沿用当前 provider、只换模型名（Skill spec F11）。 */
  async function isolatedClient(skill: SkillDef): Promise<LLMClient> {
    if (!skill.model) return clientRef.current!;
    return createClient({ ...selectedProvider, model: skill.model }, segmentsRef.current!);
  }

  /** 跑一次独立子对话并渲染事件；斜杠调用与模型调用 loadSkill 共用。 */
  async function runIsolated(skill: SkillDef, args: string, context: Pick<ToolContext, "signal" | "permission">): Promise<IsolatedOutcome> {
    // 快照取在追加任何新消息之前；末尾悬空的 loadSkill 调用由 recentHistory 丢掉。
    const history = conversationRef.current.getMessages();
    const renderer = createEventRenderer(`[${skill.name}] `, { streamText: false, updateUsage: false });
    const generator = runIsolatedSkill({
      skill, args, history,
      client: await isolatedClient(skill),
      registry: registryRef.current,
      protocol: selectedProvider.protocol,
      workDir,
      mode: modeRef.current,
      permission: context.permission,
      signal: context.signal,
    });
    for (;;) {
      const step = await generator.next();
      if (step.done) return step.value;
      if (step.value.type !== "done") renderer.render(step.value);
    }
  }

  /**
   * 独立 Skill 的斜杠调用（Skill spec F11）：结束后主历史只追加原命令与结果两条，
   * 子对话不进主历史、不进存档，也不交给记忆整理器。
   */
  function runIsolatedTurn(skill: SkillDef, args: string, display: string): boolean {
    setMessages((previous) => {
      const next: ChatMessage[] = [...previous, { role: "user", content: display }];
      advanceCommit(next);
      return next;
    });
    setCompletionMark("");
    setError(null);
    setStreamingText("");
    setIsStreaming(true);
    activityRef.current = "agent";
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    void (async () => {
      try {
        let outcome: IsolatedOutcome;
        try {
          outcome = await runIsolated(skill, args, { signal, permission: buildGate() });
        } catch (cause) {
          outcome = { ok: false, text: `子对话执行失败：${cause instanceof Error ? cause.message : String(cause)}` };
        }
        const text = resultMessage(skill.name, outcome);
        conversationRef.current.addUserMessage(display, display);
        conversationRef.current.addAssistantMessage(text);
        setMessages((previous) => {
          const next: ChatMessage[] = [...previous, { role: "assistant", content: text, isError: !outcome.ok }];
          advanceCommit(next);
          return next;
        });
        if (outcome.ok) setCompletionMark(randomCompletionVerb());
      } finally {
        finishTurn();
      }
    })();
    return true;
  }

  // 模型经 loadSkill 调用独立 Skill 时的运行器（Skill plan「独立模式：模型调用」）：
  // 结果由 loadSkill 作为工具结果回灌，这里不追加主历史。每次渲染重新注入，闭包读到的是最新的 ref。
  skillManager.setIsolatedRunner((skill, args, context) => runIsolated(skill, args, context));

  /** 原 /compact 分支：维护期间禁用输入，结束后复位。 */
  function compactWithMaintenance(): Promise<void> {
    activityRef.current = "maintenance";
    setIsMaintaining(true);
    return handleCompact().catch((cause) => setError(String(cause))).finally(() => {
      activityRef.current = "idle";
      setIsMaintaining(false);
    });
  }

  /** 原 /resume 分支：运行中先中断当前轮，收尾后再打开列表。 */
  function openResume(): void {
    const sessions = listSessions(workDir, sessionWriterRef.current!.id);
    if (!sessions.length) addNotice("暂无历史会话");
    else if (activityRef.current === "agent") {
      pendingResumeRef.current = sessions;
      if (confirmResolveRef.current) settleConfirm("deny");
      abortControllerRef.current?.abort();
    } else setResumeList(sessions);
  }

  /**
   * /clear：清空对话区与历史、切到新会话存档（斜杠命令 spec F12）。
   * Static 只追加不回收，必须清屏并换 key 重新挂载，横幅才会从头输出。
   */
  function clearConversation(): void {
    conversationRef.current.restore([]);
    compactorRef.current?.resetFailures();
    compactorRef.current?.estimator.resetAnchor();
    completedToolIdsRef.current.clear();
    committedIndexRef.current = 0;
    setInputTokens(0);
    setOutputTokens(0);
    setCacheReadTokens(0);
    setCacheCreationTokens(0);
    setError(null);
    setCompletionMark("");
    setStreamingText("");
    const id = startNewSession();
    modeTrackerRef.current.setMode(mode);
    // 新会话从零开始：已激活 Skill 一并停用（Skill spec F12）。
    skillManager.deactivate();
    writeStdout("\x1b[2J\x1b[3J\x1b[H");
    setStaticKey((key) => key + 1);
    setMessages([{ role: "system", content: `已清空对话，开始新会话 ${id}（旧会话可用 /resume 找回）` }]);
  }

  // 界面控制接口（斜杠命令 spec F8）：命令实现只经它操作界面。
  const commandUI: CommandUI = {
    showMessage: (text, isError = false) => addNotice(text, isError),
    sendUserMessage: (display, prompt) => startAgentTurn(display, prompt),
    setPermissionMode: (next) => switchPermissionMode(next),
    getUsage: () => {
      const contextWindow = getContextWindow(selectedProvider);
      const compactor = compactorRef.current;
      return {
        inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextWindow,
        usedTokens: compactor ? contextWindow - compactor.remainingTokens() : null,
      };
    },
    refreshStatus: () => setStatusTick((tick) => tick + 1),
    clearConversation,
    compact: compactWithMaintenance,
    openResume,
    exit: () => {
      memoryUpdaterRef.current?.abort();
      exit();
    },
    snapshot: () => {
      const id = sessionWriterRef.current!.id;
      const notes = (scope: NoteScope) => new MemoryStore(memoryDir(scope, workDir, homeDir)).list()
        .map((note) => ({ name: note.name, type: note.type, description: note.description }));
      return {
        provider: { name: selectedProvider.name, protocol: selectedProvider.protocol, model: selectedProvider.model, baseUrl: selectedProvider.base_url },
        permissionMode: permissionModeRef.current,
        rules: rulesRef.current,
        session: { id, messageCount: conversationRef.current.len(), path: join(sessionsDir(workDir), `${id}.jsonl`) },
        memory: { user: notes("user"), project: notes("project") },
        mcp: mcpReports,
      };
    },
    listSkills: () => skillManager.list().map((skill) => ({
      name: skill.name, description: skill.description, mode: skill.mode, source: skill.source, active: skillManager.isActive(skill.name),
    })),
    deactivateSkills: (name) => skillManager.deactivate(name),
    invokeSkill,
  };

  function handleSubmit(text: string): boolean {
    if (activityRef.current === "maintenance") return false;
    const busy = activityRef.current === "agent";
    const result = dispatch(text, { registry: commandRegistry, ui: commandUI, busy });
    if (result === "rejected") return false;
    if (result === "done") {
      setPromptHistory((previous) => [...previous, text]);
      return true;
    }
    if (busy) {
      addNotice("Agent 运行中，仅支持 /resume 等斜杠命令；可按 Esc 中断");
      return false;
    }
    if (!startAgentTurn(text, text)) return false;
    setPromptHistory((previous) => [...previous, text]);
    return true;
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
      <Static key={staticKey} items={staticItems}>
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
        : resumeList
          ? <SessionSelect sessions={resumeList} onSelect={(id) => { void handleResume(id); }} onCancel={() => setResumeList(null)} />
          : <InputBox
              onSubmit={handleSubmit}
              disabled={isMaintaining}
              history={promptHistory}
              suggest={(text) => suggest(text, commandRegistry)}
              suggestionsOpenRef={suggestionsOpenRef}
            />}
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
