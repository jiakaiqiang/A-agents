# System Prompt Plan

> 实现语言：TypeScript（`typescript/` 子项目）。本文档与语言相关。

## 架构概览

改动集中在三层，互不交叉：

**提示词层**（`src/prompt/`）：负责把模块组装成两段文本，以及生成运行期补充指令。
新增一个运行期注入模块，改造既有的组装器与模块内容。这一层不认识协议、不认识界面，
纯函数与纯状态机，可直接断言。

**协议层**（`src/llm/`）：负责把两段文本落到各协议的缓存单元上，把补充指令挂到当次
请求的消息尾部。三种协议各自处理自己的消息形态，共用同一份标签格式。

**编排与界面层**（`src/agent/`、`src/tui/`）：负责按轮次驱动注入、把缓存用量透到状态栏。
循环本身不产生补充指令，只做透传。

数据流向单向：界面每轮向提示词层要一次补充指令 → 交给循环 → 循环透传给协议层 → 协议层
挂到请求上。补充指令不回流到会话历史。

```
        ┌──────────────── 构造期（一次）─────────────────┐
        │  buildSystemPrompt() → { stable, environment } │
        │            ↓                                    │
        │  createClient(config, segments)                 │
        └─────────────────────────────────────────────────┘

        ┌──────────────── 每轮（用户发一条）──────────────┐
        │  ModeTracker.nextTurn() → reminders: string[]   │
        │            ↓                                    │
        │  runLoop({ ..., reminders })                    │
        │            ↓  每次迭代都带上                     │
        │  collectStream(client, conv, tools, { reminders })│
        │            ↓                                    │
        │  client.stream() → 挂到消息尾部，不写历史        │
        └─────────────────────────────────────────────────┘
```

## 核心数据结构

### Section（沿用，`prompt/sections.ts`）

```ts
export interface Section {
  name: string;
  priority: number;
  content: string;
}
```

不变。组装器只读 `priority` 与 `content`，`name` 供测试与调试定位（F1）。

### SystemPromptSegments（新增，`prompt/builder.ts`）

```ts
/** 系统提示词的两个缓存单元：stable 逐字节稳定，environment 每天/每次切分支可变。 */
export interface SystemPromptSegments {
  stable: string;
  environment: string;
}
```

`buildSystemPrompt` 的返回类型由 `string` 改为本类型（F6）。这是本章唯一的破坏性签名变更，
影响 `createClient` 与三个客户端构造函数。

### BuildOptions（改造，`prompt/builder.ts`）

```ts
export interface BuildOptions {
  tools?: ToolSummary[];      // 始终传全量工具，不随模式过滤（见技术决策）
  customInstructions?: string;
  skills?: string;
  memory?: string;
}
```

去掉 `mode` 字段：稳定段不再随模式变化（F9/F16）。

### StreamOptions（新增，`llm/client.ts`）

```ts
export interface StreamOptions {
  signal?: AbortSignal;
  /** 当次请求挂载的补充指令，不写入会话历史。 */
  reminders?: string[];
}

export interface LLMClient {
  stream(
    conversation: ConversationManager,
    tools: Record<string, unknown>[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent>;
}
```

`stream` 的第三个位置参数由 `abortSignal` 改为选项对象。两个可选参数用位置传递容易错位，
且后续章节还会往这里加东西（N5）。

### ModeTracker（新增，`prompt/reminder.ts`）

```ts
/** 会话级模式状态与注入强度计数。每个会话一个实例，跨轮存活。 */
export class ModeTracker {
  /** 切换模式时重置计数；模式未变时无副作用（F15）。 */
  setMode(mode: AgentMode): void;
  /** 推进一轮并返回本轮应注入的补充指令；执行模式返回空数组（F14）。 */
  nextTurn(): string[];
}
```

计数是「该模式下已进行的轮次」，一轮 = 用户发一条消息，与循环内的迭代次数无关。

## 模块设计

### prompt/sections.ts（改造）

**职责：** 声明 7 个固定模块与环境模块的内容，每个模块一个纯函数返回 `Section`。

**对外接口：**

```ts
identitySection(): Section
safetySection(): Section
taskModeSection(): Section
behaviorSection(): Section
codeStyleSection(): Section
usingToolsSection(tools: ToolSummary[]): Section
outputStyleSection(): Section
environmentSection(env: EnvironmentContext): Section
```

**依赖：** `tools/limits.ts`（优先级常量）、`agent/events.ts`（无——`AgentMode` 依赖移除）。

各模块内容要点（F2，具体措辞在实现时定稿）：

| 模块 | 内容要点 |
|------|---------|
| 身份 | 是谁、在终端环境协助编程、当前工作目录内活动 |
| 安全边界 | 不越出工作目录；不回显密钥令牌；破坏性与不可逆操作先确认；不擅自 push/部署 |
| 任务模式 | 存在计划与执行两种模式，各自含义；**不声明当前是哪个**（F16） |
| 行为 | 动手前先读相关文件；改动范围最小化；不顺手改无关代码；命令失败先读错误再动 |
| 代码规范 | 匹配现有风格与依赖；中文注释；严格类型；上限集中声明；不引入重复依赖 |
| 工具使用 | 工具名清单；可一轮内连续调用多个；编辑前先读；查找搜索用专用工具；相对路径（F18） |
| 输出风格 | 中文作答；简洁直接；路径与代码用代码块标注；篇幅与结构按任务量取舍 |
| 环境信息 | 工作目录、系统与架构、Shell、Git 状态与分支、模型、日期（F5） |

`usingToolsSection` 的两处改动：
1. 删除现有的计划模式分支（当前 `sections.ts:69-78`），该内容移入 `prompt/reminder.ts`（F16）。
2. 工具清单只列**名称**，不再重复完整描述——完整描述已通过 `tools` 参数下发，重复一遍会
   让前缀多出近千 token（N3）。

`tools` 为空数组时保留现有兜底文案（无工具可用，直接以文本协助），满足 N4。

### prompt/builder.ts（改造）

**职责：** 按优先级组装模块，产出两段文本；探测环境上下文。

**对外接口：**

```ts
export class PromptBuilder { add(section: Section): this; build(): string }
export function detectEnvironment(workDir: string, model?: string): EnvironmentContext
export function buildSystemPrompt(env: EnvironmentContext, options?: BuildOptions): SystemPromptSegments
```

**依赖：** `prompt/sections.ts`、`tools/limits.ts`。

`PromptBuilder` 本身不改：现有的「按 priority 升序 → trim → 过滤空串 → 空行 join」正好
满足 F1 与 F4（空内容自动落空，不产生空标题与多余空行）。

`buildSystemPrompt` 改为组装两次：

- `stable`：7 个固定模块 + 3 个可选模块，走一个 `PromptBuilder`
- `environment`：`environmentSection(env).content.trim()`，单段直出，不进组装器

环境模块仍在优先级表里占最大值（100），表达「排在所有模块之后」这一意图，即使它实际
不参与同一次排序（F5）。

### prompt/reminder.ts（新增）

**职责：** 运行期补充指令的标签格式、模式指令文案、按轮次的注入强度决策。

**对外接口：**

```ts
/** 用约定标签包裹一条补充指令，使模型识别为系统级背景说明（F10）。 */
export function wrapReminder(content: string): string
export class ModeTracker { setMode(mode: AgentMode): void; nextTurn(): string[] }
```

**依赖：** `tools/limits.ts`（`PLAN_REMINDER_INTERVAL`）、`agent/events.ts`（`AgentMode` 类型）。

标签形态：

```
<system-reminder>
（指令正文）
</system-reminder>
```

选这个形态的理由见技术决策表。

模式指令两个版本：

- **完整版**（计划模式第 1、6、11… 轮）：当前处于计划模式；只能读取与检索信息，不要修改
  文件或执行有副作用的命令；应当产出一份可执行的计划文本而不是直接动手；用户切回执行
  模式后才实施。
- **精简版**（其余轮）：一句话——当前处于计划模式，只读不改。

`nextTurn()` 的判定：执行模式返回 `[]`；计划模式下 `(turns - 1) % PLAN_REMINDER_INTERVAL === 0`
时给完整版，否则给精简版。`turns` 从 1 开始计，`setMode` 检测到模式变化时归零（F14/F15）。

### llm/anthropic.ts（改造）

**职责：** 两个缓存单元的落点；补充指令以文本块挂到最后一条用户消息。

**改动点：**

1. 构造函数参数 `systemPrompt: string` → `segments: SystemPromptSegments`。
2. `system` 字段由一个文本块改为两个，各自带 `cache_control`（F6）：

```ts
system: [
  { type: "text", text: segments.stable,      cache_control: { type: "ephemeral" } },
  { type: "text", text: segments.environment, cache_control: { type: "ephemeral" } },
],
```

3. `buildAnthropicMessages(history, reminders)` 新增第二参数。补充指令追加到最后一条用户
   消息的内容块尾部：内容是块数组时 push 一个 `{type:"text"}` 块；内容是字符串时改为块
   数组后 push；末条不是用户消息时新建一条用户消息。这样不产生连续两条同角色消息（F13）。
4. `markLastUserTailForCache` **不动**（D4，本章不修消息通道断点）。

### llm/openai.ts（改造）

**职责：** 同上，适配两种 OpenAI 协议。

**改动点：**

1. 两个客户端的构造函数参数同样改为 `segments`。
2. 系统内容拼成单条系统消息：`${stable}\n\n${environment}`。OpenAI 系是自动前缀缓存、
   没有显式断点，缓存按 token 前缀匹配而非消息边界，拼成一条与拆成两条效果相同，
   且避免部分兼容网关不接受多条系统消息（见技术决策）。
3. `buildOpenAIInput(history, reminders)` 与 `buildChatCompletionMessages(history, reminders)`
   各新增第二参数，把补充指令作为一条 `role: "user"` 消息追加到末尾。两种协议都接受连续
   同角色消息。

### agent/collect.ts、agent/loop.ts（改造）

**职责：** 把补充指令从界面透传到协议层。两处都只做透传，不产生也不修改指令内容。

**改动点：**

- `collectStream(client, conversation, tools, options?: StreamOptions)`：第四参数由
  `signal` 改为选项对象，原样转给 `client.stream`。
- `LoopOptions` 新增 `reminders?: string[]`；`runLoop` 内每次调 `collectStream` 都带上，
  使本轮的每次模型请求都携带（F14）。

循环内已有的 `registry.definitionsFor(protocol, { readOnlyOnly: mode === "plan" })`
（`loop.ts:104`）保持不变——工具集过滤本来就在每次迭代时按模式现算，不依赖客户端重建（F9）。

### tui/app.tsx（改造）

**职责：** 持有会话级状态，每轮驱动一次注入，展示缓存用量。

**改动点：**

1. 构造提示词的 `useEffect` 依赖数组去掉 `mode`（当前 `app.tsx:112`），使切模式不再重建
   提示词与客户端（F9/AC9）。
2. 传给 `buildSystemPrompt` 的工具清单改为始终 `registry.list()`（当前 `app.tsx:93` 按模式
   在 `list()` 与 `listReadOnly()` 间切换）——稳定段必须与模式无关。
3. 新增 `modeTrackerRef`（与 `conversationRef` 并列，会话级存活）。每轮发送前：
   `setMode(mode)` → `nextTurn()` → 结果传入 `runLoop`。
4. 新增两个 state 承接 `usage` 事件里的 `cacheReadInputTokens` / `cacheCreationInputTokens`，
   传给状态栏（F20/F21）。

### tui/status-bar.tsx（改造）

**职责：** 展示。

**改动点：** 新增 `cacheReadTokens`、`cacheCreationTokens` 两个可选 props，两个数分开显示：

```
执行 · claude-opus-4 · 12.4K↓ 1.2K↑ · 缓存 8.2K读 1.3K写
```

两数均为 0 时省略「缓存」这一段，避免首轮和无缓存协议下显示一串零（F21）。

### tools/limits.ts（改造）

**职责：** 上限与常量单点声明（N8）。

新增三项，与既有 `MAX_ITERATIONS` 等放在一起：

```ts
// ── 系统提示词模块优先级（spec N8）──
// 升序拼装；可选模块排在固定模块之后，环境信息排在最末。
export const PROMPT_PRIORITY = {
  identity: 0,
  safety: 10,
  taskMode: 20,
  behavior: 30,
  codeStyle: 40,
  usingTools: 50,
  outputStyle: 60,
  customInstructions: 70,
  skills: 80,
  memory: 90,
  environment: 100,
} as const;

// 计划模式完整版指令的重复间隔轮数（spec F14）。
export const PLAN_REMINDER_INTERVAL = 5;

// 最小可缓存前缀长度门槛，按整个请求前缀（工具定义 + 系统提示词）计算。
// Anthropic Opus / Sonnet 为 1024，Haiku 为 2048；换模型时需复核（spec N1）。
export const CACHE_MIN_PREFIX_TOKENS = 1024;
```

### 六个工具的描述（改造）

**职责：** 在工具描述内嵌与该工具相关的关键约定（F17）。

| 工具 | 新增约定 |
|------|---------|
| `Read` | 相对路径 |
| `Write` | 覆盖已有文件前必须先 Read 确认当前内容；相对路径 |
| `Edit` | 必须先 Read 当前内容再替换，否则匹配会失败；相对路径 |
| `Bash` | 查找文件用 Glob、搜索内容用 Grep、读文件用 Read，不要用命令行拼凑 |
| `Glob` | 查找文件优先用本工具而不是命令行；相对路径 |
| `Grep` | 搜索内容优先用本工具而不是命令行 |

措辞需与系统提示词「工具使用」「行为」两个模块逐字对齐（F19）。

## 模块交互

**构造期**（选定 provider 后一次，切模式不重跑）：

```
app.tsx
  └─ detectEnvironment(workDir, model) ─────────────→ EnvironmentContext
  └─ registry.list() ───────────────────────────────→ ToolSummary[]（全量）
  └─ buildSystemPrompt(env, { tools }) ─────────────→ { stable, environment }
  └─ createClient(provider, segments)
        └─ AnthropicClient / OpenAIClient / OpenAICompatClient
```

**每轮**（用户发一条消息）：

```
app.tsx  onSubmit
  ├─ modeTrackerRef.setMode(mode)          ← 模式变了就归零计数
  ├─ modeTrackerRef.nextTurn()             → string[]（0 或 1 条）
  └─ runLoop({ ..., reminders })
       └─ 每次迭代：
            ├─ registry.definitionsFor(protocol, { readOnlyOnly: mode === "plan" })
            ├─ collectStream(client, conversation, tools, { signal, reminders })
            │    └─ client.stream(...)
            │         └─ buildXxxMessages(history, reminders)   ← 挂到消息尾部
            └─ yield usage → app.tsx → StatusBar
```

关键点：`reminders` 只在这条链上流动，任何一环都不调 `conversation.add*`，所以不进历史
（F12）。历史里存的始终只有真实对话与工具结果。

## 文件组织

```
typescript/src/
├── prompt/
│   ├── builder.ts     — PromptBuilder、detectEnvironment、buildSystemPrompt（返回两段）
│   ├── sections.ts    — 7 个固定模块 + 环境模块，内容展开
│   └── reminder.ts    — 【新增】wrapReminder、ModeTracker、两版模式指令文案
├── llm/
│   ├── client.ts      — StreamOptions、createClient 接收 segments
│   ├── anthropic.ts   — 两个 system 文本块各带 cache_control；消息尾挂补充指令
│   └── openai.ts      — 系统内容拼一条；补充指令作为末尾 user 消息
├── agent/
│   ├── collect.ts     — 第四参数改选项对象，透传
│   └── loop.ts        — LoopOptions.reminders，每次迭代带上
├── tui/
│   ├── app.tsx        — 去掉 mode 依赖、ModeTracker ref、缓存用量 state
│   └── status-bar.tsx — 缓存读取/创建两个 props
└── tools/
    ├── limits.ts      — PROMPT_PRIORITY、PLAN_REMINDER_INTERVAL、CACHE_MIN_PREFIX_TOKENS
    └── read/write/edit/bash/glob/grep.ts — 描述内嵌关键约定

typescript/tests/
├── prompt/
│   ├── builder.test.ts   — 【新增】顺序、逐字节稳定、可选空段、模式无关、长度门槛
│   └── reminder.test.ts  — 【新增】标签格式、5 轮间隔规律、切模式归零
└── llm/
    └── messages.test.ts  — 【新增】两个缓存块、三协议都带上补充指令、不进历史

docs/specs/system-prompt/
└── scenarios.md      — 【新增】四类定性评估场景（F22）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 提示词返回形态 | 返回 `{ stable, environment }` 对象，不返回字符串数组 | 两段语义不同（一段稳定、一段每天变），命名字段比下标自解释；后续要加第三段时也不会打乱既有调用方 |
| 环境段是否单独打断点 | 打（Anthropic） | 不打则跨天时它前面的工具定义与稳定段一起重写；它自身仅约 67 token，单独缓存的收益可忽略，真正的收益是保护它前面的约 1300 token |
| OpenAI 系是否拆两条系统消息 | 不拆，拼成一条 | OpenAI 是自动前缀缓存、没有显式断点，缓存按 token 前缀匹配而非消息边界，拆与不拆等效；拼成一条可避开部分兼容网关不接受多条系统消息的风险 |
| 提示词里的工具清单 | 只列名称，不重复完整描述 | 完整描述已随 `tools` 参数下发，重复一遍让前缀多出近千 token，与 N3 冲突；模型选工具依据的是 `tools` 里的描述 |
| 稳定段的工具清单是否随模式过滤 | 不过滤，始终全量 | 过滤会让稳定段随模式变化，直接违反 F9/AC9；实际的能力约束由 `definitionsFor` 的工具集过滤与运行期注入的模式指令共同保证，不依赖提示词里的清单 |
| 补充指令的标签 | `<system-reminder>` 成对标签 | 尖括号标签在训练语料里普遍作为结构化边界出现，模型倾向把其中内容当背景而非提问；纯文本前缀（如「系统提示：」）更容易被当成用户话语来回应 |
| 补充指令挂载位置 | 消息数组末尾 | 越靠近生成位置约束力越强；代价是每次迭代末尾都变，会影响消息通道缓存——本章不做消息通道缓存（D4），后续章节实现时需重新权衡挂载位置 |
| 补充指令的挂载实现 | 各协议在自己的 `buildXxx` 里挂，共用 `wrapReminder` | Anthropic 需要按内容块结构追加（末条可能是 `tool_result` 块数组），两个 OpenAI 协议直接追加一条消息即可；强行抽成协议无关的单一实现会把三种形态的分支都塞进一处 |
| `stream` 第三参数 | 改为 `StreamOptions` 选项对象 | 两个可选位置参数容易错位；后续章节还会往这里加内容（N5） |
| `ModeTracker` 归属 | 独立类，实例存在 `app.tsx` 的 ref 里 | 计数需跨轮存活，而 `runLoop` 每轮新建、无法持有；不放进 `ConversationManager` 是为了不把「模式策略」混进「历史存储」 |
| 一轮内多次请求的注入 | 每次迭代都带上 | 一轮可能十几次迭代，只在首次带上则后续迭代完全失去约束；重复的是同一份文本，不累加 |
| 门槛校验方式 | 测试里用估算器断言，不做运行时检查 | AC24 要求「经实测超过门槛且门槛值有记录」，测试即是记录；运行时检查无法自动补救，只会多一条日志 |
| `addSystemReminder` 处置 | 保留不动，新通道不使用它 | 它在 Anthropic 协议下被静默丢弃（`anthropic.ts:12`）是既有缺陷，但删改它超出本章范围。**它将成为无调用方的死代码，需要你决定是否本章一并清理** |

## 已知风险

1. **现有工具测试可能断言了描述文本。** 六个工具的描述都要改，若 `tests/tools/*.test.ts`
   里有对描述的断言会失败。实现时先跑一遍现有测试确认基线，再改描述。
2. **Anthropic 连续同角色消息。** 补充指令按块追加而非新建消息，正是为了回避这一点。
   若某种历史形态下仍需新建用户消息（末条是助手消息时），需实测确认接口接受。
3. **计划模式前缀长度。** 只读工具约 426 token，稳定段展开后必须超过约 600 token 才能让
   计划模式的第一个缓存单元过 1024 门槛。模块内容定稿后需实测，这与 N3 的「长度受控」
   构成一对相反的压力。
4. **Haiku 门槛翻倍。** 换到 Haiku（2048）时当前前缀量级不够。本章只按 N1 记录门槛值，
   不实现按模型切换门槛。

## 自检

- **spec 覆盖**：F1–F22 逐条有归属。F3/F19 属内容审查、无对应代码模块，由 checklist 阶段
  的人工比对覆盖；F22 落在 `scenarios.md` 文档。无缺口。
- **接口完整性**：`SystemPromptSegments`、`StreamOptions`、`ModeTracker`、`wrapReminder`
  四个新接口均给出完整签名与语义，各模块可独立实现。
- **依赖清晰度**：`prompt/` → `tools/limits.ts` 单向；`llm/` → `prompt/`（仅类型）；
  `agent/` → `llm/`；`tui/` → 全部。无环。
- **矛盾检查**：一处需要指出——D2 接受「切模式导致整体前缀重建」，而 F9/AC9 要求「切模式
  不重建稳定段」。两者不冲突：F9 说的是稳定段**内容**不变、客户端不重建，D2 说的是该次
  请求因工具集变化而**缓存未命中**。本 plan 靠「稳定段不含模式、工具清单不过滤」保证前者，
  后者按 D2 接受。
