# 上下文管理 Plan

## 架构概览

上下文管理由 4 个新模块组成，挂在既有 Agent Loop 与工具执行链路上，均为纯逻辑层：

```
src/context/
├── tokens.ts      — Token 估算器（锚点 + 增量字符折算）
├── spill.ts       — 第一层：工具结果存盘（写文件、生成预览）
├── summarizer.ts  — 第二层：摘要 Prompt 构造与 LLM 调用（禁工具、草稿）
└── compactor.ts   — 编排：分界计算、两层检查入口、历史替换、熔断计数
```

```
runLoop（每次请求前）
    │
    ▼
compactor.maintain()  ←─ 熔断状态、锚点由其持有
    │
    ├─ 轻量预防：对新产出的 toolResults 调 spill.maybeSpill()（在写入历史前）
    │
    └─ 总量检查：estimator.estimate(history) > 窗口−13K ？
            │ 是
            ▼
        summarizer.buildPrompt() → client.stream()（收集文本，忽略工具调用）
            │
            ▼
        conversation.replaceWithCompacted([摘要消息, ...近期原文, 边界消息])
        estimator.resetAnchor()
```

TUI 只消费两类新增信号：AgentEvent 新增 `compaction` 事件（呈现提示），`/compact` 斜杠命令直接调 `compactor.compact()`。

## 核心数据结构

### TokenEstimator（tokens.ts）

```ts
export class TokenEstimator {
  /** 锚定最近一次请求的真实 input tokens；null 表示尚无锚点。 */
  private anchor: { historyChars: number; inputTokens: number } | null = null;

  /** 锚点基于锚定时的历史总字符数；调用时机在每轮请求返回 usage 之后。 */
  setAnchor(historyChars: number, inputTokens: number): void;
  /** 压缩后调用：丢弃旧锚点，回到纯字符估算。 */
  resetAnchor(): void;
  /** 增量部分 = (当前字符数 − 锚点字符数) / 4，加到锚点值上；无锚点全量 /4。 */
  estimate(totalChars: number): number;
  estimateMessages(messages: Message[]): number; // 便捷入口：遍历求字符后 estimate
}
```

估算口径：自然语言消息按 `content.length`；工具结果按各 `toolResults[].content.length`；工具调用按 JSON 序列化长度。统一 4 字符 ≈ 1 token。

### SpillManager（spill.ts）

```ts
export const SPILL_PREVIEW_CHARS = 500;
export const TOOL_SPILL_TOKENS = 2_000;   // 单条存盘阈值（F2）
export const MESSAGE_SPILL_TOKENS = 8_000; // 单条消息合计阈值（F3）

export interface SpillOutcome {
  content: string;     // 替换后的回灌文本：预览 + 路径行；未存盘时为原文
  spilled: boolean;
  filePath?: string;
}

/** 单条判定+存盘；由轻量预防按 F2/F3 的次序驱动。 */
export async function maybeSpillResult(
  toolName: string,
  result: ToolResult,
  workDir: string,
  estimator: TokenEstimator,
): Promise<SpillOutcome>;
```

- 存盘路径：`<workDir>/.mewcode/tool-outputs/<toolName>-<yyyyMMdd-HHmmss>-<6位随机>.txt`
- 预览格式：原文开头 500 字符 + `\n\n[完整输出已存盘：/posix/路径（N 字符）。需要细节请用 Read 读取该文件]`
- 目录首次使用时自动创建（`mkdirSync recursive`）；写失败时降级为「不存盘、回原文（30K 截断兜底仍在）」，不打断工具流。

### Summarizer（summarizer.ts）

```ts
export function buildSummaryPrompt(history: Message[]): { system: string; user: string };
export async function generateSummary(
  client: LLMClient,
  history: Message[],       // 待摘要区
  signal?: AbortSignal,
): Promise<{ summary: string; usage: UsageInfo }>;
```

- Prompt 结构：system 部分（角色设定 + 三条硬规则：禁用工具、先草稿后正式、草稿用后即弃）+ user 部分（九段结构模板 + 待摘要消息的文本化转储）。
- 调用方式：复用 `LLMClient.stream()`，但**传空工具列表**——模型无工具可调，从根上满足「禁止调工具」；同时收集 text 增量拼接为摘要文本。
- 摘要请求发不出去（估算超窗）时按 F10 预截短：`truncateForSummary(history)` 从尾部保留 5 轮原始对话（assistant+配对 tool_result 算一轮），更早的部分替换为一行占位文本。

### Compactor（compactor.ts）

```ts
export const AUTO_MARGIN_TOKENS = 13_000; // 自动触发安全余量（F6）
export const MANUAL_MARGIN_TOKENS = 3_000; // 手动压后校验余量（F13）
export const KEEP_RECENT_TOKENS = 10_000; // 近期原文区 token 线（F7）
export const KEEP_RECENT_NATURAL = 5;     // 近期自然语言消息条数线（F7）
export const MAX_SUMMARY_FAILURES = 3;    // 熔断阈值（F14）

export interface CompactionResult {
  compacted: boolean;
  summaryMessageCount: number; // 被摘要掉的消息条数
  recentCount: number;         // 近期原文保留条数
  error?: string;              // 失败原因（熔断计数已加一）
}

export class Compactor {
  constructor(client, conversation, estimator, workDir);
  get circuitOpen(): boolean;   // 熔断状态
  resetFailures(): void;        // 手动成功后调用（F14）

  /** F2/F3 的次序编排：对刚产出的结果数组逐条判定存盘。 */
  async applyLightPrevention(toolName: string, results: ToolResult[]): Promise<ToolResult[]>;

  /** 每次请求前调用：自动触发线判断 + 压缩执行。熔断打开时直接返回。 */
  async maintain(signal?: AbortSignal): Promise<void>;

  /** /compact 入口：无阈值直接压缩；返回结果供 TUI 提示。 */
  async compactManually(signal?: AbortSignal): Promise<CompactionResult>;

  /** 内部：分界计算、摘要调用、历史替换、锚点重置、失败计数。 */
  private async runCompaction(manual: boolean, signal?: AbortSignal): Promise<CompactionResult>;
}
```

分界算法（F7）：从尾向前遍历历史，累计 token；遇到自然语言消息（user 且无 toolResults，或 assistant 且有 content）计数 +1。停止条件：`tokens ≥ KEEP_RECENT_TOKENS || naturalCount ≥ KEEP_RECENT_NATURAL`，先触发者生效。边界情况：历史本身就不足分界时（全部落在近期区）不做压缩，直接返回未压缩。

## 模块设计

### tokens.ts
**职责：** 提供 Token 近似估算与锚点管理。
**对外接口：** `TokenEstimator` 类 + `estimateChars(message)` 辅助函数。
**依赖：** conversation 的 `Message` 类型。

### spill.ts
**职责：** 工具结果存盘判定与落盘、预览生成。
**对外接口：** `maybeSpillResult`、`SPILL_PREVIEW_CHARS` 等常量。
**依赖：** `node:fs`、tools 的 `ToolResult`、tokens 的估算。

### summarizer.ts
**职责：** 摘要 Prompt 构造、截短、调用 LLM 收集摘要文本。
**对外接口：** `buildSummaryPrompt`、`generateSummary`、`truncateForSummary`。
**依赖：** llm 的 `LLMClient`、conversation 的 `Message`。

### compactor.ts
**职责：** 两层检查的编排入口、分界计算、历史替换、熔断状态机、锚点重置。
**对外接口：** `Compactor` 类、全部阈值常量。
**依赖：** 上述三个模块 + ConversationManager + LLMClient。

### 接入点（既有文件小改）

**agent/batch.ts** —— `runBatches` 产出 `ToolResultBlock[]` 后、`loop` 写入历史前，不再由 loop 直接写，而是交给 Compactor 做轻量预防（见 loop.ts 接入）。batch.ts 本身不改：存盘动作放在 loop 拿到 results 之后、`addToolResultMessage` 之前。

**agent/loop.ts** —— 两处改动：
1. `LoopOptions` 新增 `compactor?: Compactor`（可选，测试不传时行为不变）。
2. 请求前：`await compactor?.maintain(signal)`；工具结果回灌前：`results = await compactor?.applyLightPrevention(results)`；收到 usage 后：`estimator.setAnchor(...)`（锚点读取由 Compactor 暴露的 `noteUsage(chars, inputTokens)` 承担，loop 不直接摸 estimator）。
3. 新增 AgentEvent：`{ type: "compaction"; text: string }`，压缩发生时 yield，TUI 呈现。

**conversation/conversation.ts** —— `replaceWithCompacted` 已存在，直接复用；新增 `chars()` 辅助（供锚点与估算调用）。

**tui/app.tsx** —— 三处：
1. `handleSubmit` 增加 `/compact` 分支：流式期间禁用；构造/复用 App 级 Compactor，调 `compactManually()`，按返回值显示提示（成功 → 压缩提示；`remainingTokens < 3K` → 异常提示；熔断中成功 → 重置熔断并提示恢复）。
2. 事件处理新增 `compaction` case → 系统消息（与 notice 同路径）。
3. App 级 `compactorRef` 在 client 就绪后创建，传给 runLoop。

**limits.ts** —— 全部新常量集中于此。

**.gitignore** —— 追加 `.mewcode/tool-outputs/`。

## 模块交互

### 每次请求前的完整链路

1. loop 发请求前调 `compactor.maintain(signal)`。
2. `maintain`：熔断开 → 直接返回。否则估算全历史，`> 窗口−13K` → `runCompaction(false)`。
3. `runCompaction`：算分界 → `truncateForSummary`（若需）→ `generateSummary` → 组装新历史 → `replaceWithCompacted` → `resetAnchor` → 失败计数归零 / 失败则 +1（达 3 次熔断）。
4. loop 拿到 usage：`compactor.noteUsage(chars, inputTokens)` 更新锚点。

### 工具结果回灌链路

1. `runBatches` 返回 `ToolResultBlock[]`（不变）。
2. loop 调 `compactor.applyLightPrevention(...)`：对每条结果按 F2 判定（单条超 2K → 存盘）；再按 F3 对整组合计判定，超 8K 从最大开始依次存盘。
3. 替换后的结果组 `addToolResultMessage` 入史（不变）。

### /compact 链路

1. TUI 调 `compactor.compactManually()` → `runCompaction(true)`（跳过阈值判断）。
2. 压后估算剩余空间 `< 3K` → TUI 显示异常提示。
3. 成功 → `resetFailures()`，自动压缩恢复。

## 文件组织

```
typescript/
├── src/
│   ├── context/
│   │   ├── tokens.ts        — TokenEstimator、estimateChars
│   │   ├── spill.ts         — maybeSpillResult、预览生成、常量
│   │   ├── summarizer.ts    — buildSummaryPrompt、generateSummary、truncateForSummary
│   │   └── compactor.ts     — Compactor 类、阈值常量、AgentEvent 复用
│   ├── agent/loop.ts        — LoopOptions.compactor、maintain/applyLightPrevention/noteUsage 接入、compaction 事件
│   ├── agent/events.ts      — AgentEvent 新增 compaction
│   ├── conversation/conversation.ts — chars() 辅助
│   ├── tools/limits.ts      — 新常量（或由 context 模块自有常量，limits 收口）
│   └── tui/app.tsx          — /compact、compactorRef、compaction 事件呈现
├── tests/context/
│   ├── tokens.test.ts
│   ├── spill.test.ts
│   ├── summarizer.test.ts
│   └── compactor.test.ts
└── .gitignore               — 追加 .mewcode/tool-outputs/
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 摘要调用方式 | 复用 `LLMClient.stream()` 且传空工具列表 | 模型物理上无工具可调，「禁工具」从协议层满足，不靠 prompt 约束；零新接口 |
| 存盘目录 | 项目内 `.mewcode/tool-outputs/` | 与既有 `.mewcode/config.local.yaml` 先例一致；模型可用 Read 直接重新读取 |
| 存盘时机 | 结果写入历史前（loop 层） | 历史里永远不出现超大原文；已入史的超大历史由第二层兜底处理 |
| 估算口径 | 锚点 + 增量/4 字符折算 | 满足 F1；不做 tokenizer（不做的事），usage 锚定消除累积误差 |
| Compactor 持有熔断与锚点 | 单实例挂在 App 级，跨轮存活 | 熔断计数、锚点本质是会话级状态，放 loop 内会随轮次丢失 |
| loop 集成方式 | `LoopOptions.compactor?` 可选 | 现有 17 个 loop 测试不传即不受影响；压缩逻辑可独立测试 |
| 摘要角色 | user 消息承载 | 与工具结果同为 user 角色，anthropic 协议的 user 合并逻辑自然处理；无需改协议层 |
| 存盘失败降级 | 回退原文 + 30K 截断 | 存盘是优化不是正确性依赖；失败不得打断工具流 |
| 摘要截短时机 | 请求发出前临时截短（F10） | 保证摘要请求本身可发；截短只作用于请求副本，不动真实历史 |
| 阈值归属 | 集中在 compactor.ts 顶部导出，limits.ts 收口引用 | 与既有「全部资源上限集中在 limits」的约定一致（N4） |
