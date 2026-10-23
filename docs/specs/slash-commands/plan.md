# 斜杠命令系统 Plan

## 架构概览

新增 `src/commands/` 模块，不依赖 Ink；界面层只实现接口与接入分流。

| 组件 | 职责 |
|---|---|
| 类型 `types.ts` | 命令定义、界面控制接口 CommandUI、状态快照 |
| 注册中心 `registry.ts` | 登记时校验 + 冲突检测；按名称/别名查找；列出命令 |
| 解析器 `parser.ts` | 纯函数：输入 → 空 / 普通文本 / 命令（名 + 参数） |
| 分发器 `dispatcher.ts` | 解析 → 查找 → 运行中检查 → 参数校验 → 按类型执行 → 兜异常 |
| 补全 `completion.ts` | 纯函数：输入文本 → 建议列表 |
| 格式化 `format.ts` | 纯函数：/help、/status、/session、/memory、/permission 的展示文本；档位标签表 |
| 内置命令 `builtins/` | 14 条命令定义 + `createBuiltinRegistry()` |
| 界面层 | app.tsx 实现 CommandUI 并在回车处分流；InputBox 加补全列表；状态栏用英文档位标签 |

## 核心数据结构

```ts
export type CommandKind = "local" | "ui" | "prompt";

interface BaseCommand {
  name: string;               // 主名，不带斜杠，小写
  aliases: string[];
  description: string;
  usage: string;              // 如 "/help [命令名]"
  availableWhileBusy: boolean;
  argHint?: string;           // 如 "[命令名]"；有它才接受参数（F7）
  hidden?: boolean;
}

/** 本地类与界面类：必须有执行逻辑。 */
export interface RunCommand extends BaseCommand {
  kind: "local" | "ui";
  run(ctx: CommandContext): void | Promise<void>;
}

/** 提示词类：固定模板，有参数时末尾追加「argLabel：参数」。 */
export interface PromptCommand extends BaseCommand {
  kind: "prompt";
  template: string;
  argLabel?: string;          // /review 为 "审查范围"
}

export type CommandDef = RunCommand | PromptCommand;

export interface CommandContext {
  args: string;
  ui: CommandUI;
  registry: CommandRegistry;  // /help 要列命令
}

export type ParsedInput =
  | { type: "empty" }
  | { type: "text"; text: string }
  | { type: "command"; name: string; args: string };

/** 分发结果：not-command 交回调用方送 Agent；done 清空输入；rejected 保留输入。 */
export type DispatchResult = "not-command" | "done" | "rejected";

export interface Suggestion { name: string; description: string }
```

### CommandUI（F8）

```ts
export interface CommandUI {
  showMessage(text: string, isError?: boolean): void;
  /** 对话区显示 display，模型收到 prompt；客户端未就绪返回 false。 */
  sendUserMessage(display: string, prompt: string): boolean;
  setPermissionMode(mode: PermissionMode): void;
  getUsage(): UsageSnapshot;
  refreshStatus(): void;
  clearConversation(): void;
  compact(): Promise<void>;
  openResume(): void;
  exit(): void;
  snapshot(): StatusSnapshot;
}

export interface UsageSnapshot {
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number;
  contextWindow: number;
  usedTokens: number | null;  // Compactor 未就绪时为 null
}

export interface StatusSnapshot {
  provider: { name: string; protocol: string; model: string; baseUrl: string }; // 不含 api_key
  permissionMode: PermissionMode;
  rules: RuleSet;
  session: { id: string; messageCount: number; path: string };
  memory: Record<NoteScope, Array<{ name: string; type: NoteType; description: string }>>;
  mcp: McpServerReport[];
}
```

## 模块设计

### registry.ts
**职责：** 持有命令表与「小写名/别名 → 命令」索引。
**对外接口：**
```ts
export class CommandRegistryError extends Error {}
export class CommandRegistry {
  register(def: CommandDef): void;                 // 失败抛 CommandRegistryError
  resolve(token: string): CommandDef | undefined;  // 名称或别名，不区分大小写
  list(includeHidden?: boolean): CommandDef[];     // 按主名字母序
}
```
**register 校验顺序：**
1. 把 name 与每个 alias 转小写，逐个查索引（含本条自身已登记的键）：已存在 → `命令名冲突：/<键> 同时属于 /<已有主名> 与 /<本条主名>`。先查冲突，保证大小写不同的撞名报出双方（AC2）。
2. name 与 alias 必须匹配 `/^[a-z0-9-]+$/`，否则 `命令 /<name> 的名称或别名不合法：<值>`。
3. 运行时兜底：kind 为 local/ui 却无 run，或 kind 为 prompt 却无非空 template → `命令 /<name> 缺少执行逻辑或模板`（给绕过类型检查的调用方）。
4. 全部通过后写入索引。
**依赖：** types.ts。

### parser.ts
**对外接口：** `parseInput(raw: string): ParsedInput`
**规则：** 去首尾空白为空 → empty；首字符非 `/` → text（原文 trim 后）；否则 `/^\/(\S*)\s*([\s\S]*)$/` 取命令名（转小写）与参数（trim）。
**依赖：** types.ts。

### dispatcher.ts
**对外接口：**
```ts
export function dispatch(raw: string, deps: {
  registry: CommandRegistry; ui: CommandUI; busy: boolean;
}): DispatchResult;
export function expandPrompt(def: PromptCommand, args: string): string;
```
**流程：**
1. parse：empty → done（调用方本就不会提交空输入）；text → not-command。
2. resolve 未命中 → `showMessage("未知命令：/<name>，输入 /help 查看可用命令", true)`，返回 done。
3. `busy && !availableWhileBusy` → `showMessage("Agent 运行中，请稍后或按 Esc 中断")`，返回 rejected。
4. `args && !argHint` → `showMessage("用法：<usage>", true)`，返回 done。
5. prompt 类 → `ui.sendUserMessage(raw.trim(), expandPrompt(def, args))`，false 时返回 rejected，否则 done。
6. run 类 → `try { const r = def.run(ctx); if (r) r.catch(report) } catch (e) { report(e) }`，返回 done；`report` 显示 `命令 /<name> 执行失败：<message>`（N4）。
**expandPrompt：** 无参返回 template；有参返回 `template + "\n\n" + (argLabel ? \`${argLabel}：${args}\` : args)`。
**依赖：** parser、registry、types。

### completion.ts
**对外接口：** `suggest(text: string, registry: CommandRegistry): Suggestion[]`
**规则：** 不匹配 `/^\/\S*$/`（含多行、含空白）→ `[]`；取 `/` 后前缀转小写；遍历 `registry.list(false)`，主名或任一别名以前缀开头即入选；结果天然按主名字母序、每条命令至多一项。

### format.ts
**对外接口：**
```ts
export const MODE_TAGS: Record<PermissionMode, string>; // plan→"[PLAN]"…bypass→"[BYPASS]"
export function endpointHost(baseUrl: string): string;  // 空串→"默认端点"；URL 非法→"（地址无法解析）"；否则 new URL().host
export function formatHelp(registry: CommandRegistry, target?: string): string;
export function formatStatus(snapshot: StatusSnapshot, usage: UsageSnapshot): string;
export function formatSession(snapshot: StatusSnapshot): string;
export function formatMemory(snapshot: StatusSnapshot): string;
export function formatPermission(snapshot: StatusSnapshot): string;
```
**要点：**
- formatHelp 无 target：每行 `/<name>（别名 /a, /b）  <description>`；有 target：resolve 后输出用法、别名、参数提示；未命中 → `未知命令：/<target>，输入 /help 查看可用命令`。
- formatStatus：provider 名称/协议/模型、`端点 <endpointHost>`、档位标签、Token 输入/输出/缓存读/缓存写、`上下文约 <used>/<window>（<pct>%）`（usedTokens 为 null 显示「上下文估算未就绪」）、`MCP <ok 数>/<总数> 已连接`。provider 只经 endpointHost 输出端点，完整 URL 与密钥不进文本（N5）。
- formatSession：ID、消息条数、存档路径、`可用 /resume 切换历史会话`。
- formatMemory：分「用户级」「项目级」两节，每条 `<name>（<NOTE_TYPE_LABELS[type]>）— <description>`；两级都空 → `暂无记忆`。
- formatPermission：`当前档位 <MODE_TAGS>`，按 session/local/project/user 分节列 `allow|deny <tool>(<pattern>)`，空层写「无」。
**依赖：** registry、types、`permission/types`、`memory/notes` 的 NOTE_TYPE_LABELS。

### builtins/
**职责：** 14 条命令定义；`createBuiltinRegistry(): CommandRegistry` 逐条 register 后返回。
- `info.ts`：help（别名 h，argHint `[命令名]`）、status、session、memory、permission —— local、运行中可用，run 内 `ui.showMessage(formatXxx(ui.snapshot(), …))`。
- `session.ts`：clear、compact（ui，运行中不可用）→ `ui.clearConversation()` / `await ui.compact()`；resume、exit（别名 quit、q，ui，运行中可用）→ `ui.openResume()` / `ui.exit()`。
- `mode.ts`：plan / do / accept-edits / bypass（ui，运行中可用）→ `ui.setPermissionMode(...)` 后 `ui.refreshStatus()`。
- `review.ts`：review（prompt，运行中不可用，argHint `[范围]`，argLabel `审查范围`）。模板：请用 git diff（含 --cached）查看当前工作区未提交的改动并做代码审查，按严重程度列出缺陷、潜在风险与改进建议，注明文件与位置；没有改动时直接说明。
- `index.ts`：createBuiltinRegistry。

### tui/input.tsx（InputBox）
**新增 props：** `suggest?: (text: string) => Suggestion[]`、`suggestionsOpenRef?: { current: boolean }`。
**新增状态：** `highlight`（高亮下标）、`dismissed`（Esc 收起）；文本变化时两者重置。
**派生：** `text = lines.join("\n")`；`items = suggest?.(text) ?? []`；`open = items.length > 0 && !dismissed`；初始高亮 = 与输入完全相同的主名/别名所在项，否则 0。每次渲染写 `suggestionsOpenRef.current = open`，卸载时置 false。
**按键（open 时优先于原有逻辑）：** ↑/↓ 移动高亮（夹在 0..n-1）；Tab（非 Shift）→ 文本改为 `/<name> `、光标置尾（出现空格，列表自然消失）；Enter → `onSubmit("/" + name)`，成功则清空；Esc → `dismissed = true`。open 为假时全部走原逻辑（↑↓ 翻历史）。
**渲染：** 输入框下方逐行 `❯ /name  description`（高亮项用 brand.primary，其余 brand.muted）。

### tui/app.tsx
- props 新增 `commands?: CommandRegistry`，缺省时 `useRef(createBuiltinRegistry())` 兜底（旧测试与 fixture 不必改）。
- `MODE_INFO.label` 改为引用 `MODE_TAGS`（F9）。
- 抽出 `startNewSession()`：生成新 ID → 建 writer、挂到 conversation → 释放旧占用、占用新会话。初始化与 /clear 共用。
- 抽出 `startAgentTurn(display, prompt)`：现 handleSubmit 尾部（检查 client、追加用户消息、addUserMessage、置流式状态、runAgentLoop）。display 进对话区，`addUserMessage(prompt, display)` 进 conversation 与存档，prompt 进 runAgentLoop。
- 每次渲染构造 `commandUI: CommandUI`：
  - `showMessage` → addNotice；`sendUserMessage` → startAgentTurn；`setPermissionMode` → switchPermissionMode；`refreshStatus` → 自增 `statusTick` 强制重渲染。
  - `getUsage` → 当前 Token state + `getContextWindow(selectedProvider)` + `compactor ? window - remainingTokens() : null`。
  - `clearConversation` → `conversationRef.current.restore([])`、`compactor.resetFailures()`、`compactor.estimator.resetAnchor()`、`completedToolIdsRef` 清空、`committedIndexRef = 0`、Token 与 error/completionMark 归零、`startNewSession()`、`modeTrackerRef.current.setMode(mode)`、写清屏序列 `\x1b[2J\x1b[3J\x1b[H`、`staticKey + 1`、messages 置为单条「已清空对话，开始新会话 <id>（旧会话可用 /resume 找回）」。
  - `compact` → 原 /compact 分支（置 maintenance → handleCompact → 复位）包成 Promise。
  - `openResume` → 原 /resume 分支；`exit` → 原 /exit 分支。
  - `snapshot` → 组装 provider（不含 api_key）、`permissionModeRef.current`、`rulesRef.current`、会话（writer.id、`conversation.len()`、`join(sessionsDir(workDir), id + ".jsonl")`）、两级 `MemoryStore.list()`、mcpReports。
- handleSubmit 改为：maintenance → false；`dispatch(text, { registry, ui: commandUI, busy: activity === "agent" })`；done → 记入 promptHistory、true；rejected → false；not-command 且 busy → `addNotice("Agent 运行中，仅支持 /resume 等斜杠命令；可按 Esc 中断")`、false；否则 `startAgentTurn(text, text)`，成功记入 promptHistory。
- Esc 分支改为 `key.escape && isStreaming && !suggestionsOpenRef.current`。
- `<Static key={staticKey}>`；`<InputBox suggest={(t) => suggest(t, registry)} suggestionsOpenRef={suggestionsOpenRef} … />`。

### 原命令随存档保留（F5、AC9）
- `conversation/conversation.ts`：`Message` 增加可选 `display?: string`（仅供界面展示，不发给模型）；`addUserMessage(content, display?)` 在 display 存在且不同于 content 时写入该字段。SessionWriter 原样序列化整条 Message，存档自动带上。
- `memory/session.ts`：`isMessage` 增加校验——`display` 存在时必须是字符串，否则视为损坏行（与其他字段一致）。
- `memory/resume.ts`：`displayMessages` 推入 `content: message.display ?? message.content`；跳过判断仍按 content（摘要前缀、边界文本、提醒）。
- 适配器 `buildAnthropicMessages` / `buildChatCompletionMessages` 逐字段构造请求，不读 display，无需改动；压缩摘要只读 content，同样不受影响。

### main.tsx
loadConfig 之后、MCP 连接之前：`try { commands = createBuiltinRegistry() } catch (e) { console.error(\`Error: ${e.message}\`); process.exitCode = 1; process.exit(); }`，再把 `commands` 传给 App（N6）。

## 模块交互

```
main.tsx ── createBuiltinRegistry() ──(冲突则 exit 1)──▶ App(commands)
                                                           │
InputBox ── 每次按键 suggest(text, registry) ──▶ 补全列表   │
   │ Enter / 选中高亮项                                     │
   ▼                                                       ▼
App.handleSubmit ──▶ dispatch(text, {registry, ui: commandUI, busy})
                        │ parseInput → registry.resolve → 运行中检查 → 参数校验
                        ├─ local/ui ─▶ def.run(ctx) ─▶ commandUI.*（addNotice / switchPermissionMode / clear …）
                        ├─ prompt  ─▶ commandUI.sendUserMessage(raw, expandPrompt) ─▶ startAgentTurn ─▶ runLoop
                        └─ not-command ─▶ App ─▶ startAgentTurn(text, text)
```

依赖方向：`builtins → format → registry → types`，`dispatcher → parser/registry/types`；`commands/*` 不 import `tui/*` 与 ink；`tui/*` 依赖 `commands/*`。无环。

## 文件组织

```
typescript/
├── src/commands/
│   ├── types.ts        — CommandDef / CommandUI / 快照 / ParsedInput / DispatchResult / Suggestion
│   ├── registry.ts     — CommandRegistry、CommandRegistryError
│   ├── parser.ts       — parseInput
│   ├── dispatcher.ts   — dispatch、expandPrompt
│   ├── completion.ts   — suggest
│   ├── format.ts       — MODE_TAGS、endpointHost、formatHelp/Status/Session/Memory/Permission
│   └── builtins/
│       ├── index.ts    — createBuiltinRegistry
│       ├── info.ts     — help、status、session、memory、permission
│       ├── session.ts  — clear、compact、resume、exit
│       ├── mode.ts     — plan、do、accept-edits、bypass
│       └── review.ts   — review
├── src/tui/app.tsx     — 实现 CommandUI、分流、startNewSession/startAgentTurn、/clear、Static key
├── src/tui/input.tsx   — 补全列表与按键
├── src/main.tsx        — 启动期注册与失败退出
├── src/conversation/conversation.ts — Message.display、addUserMessage(content, display?)
├── src/memory/session.ts            — isMessage 校验 display
├── src/memory/resume.ts             — displayMessages 优先用 display
└── tests/commands/
    ├── fake-ui.ts          — 记录调用的 CommandUI 假实现
    ├── registry.test.ts
    ├── parser.test.ts
    ├── dispatcher.test.ts
    ├── completion.test.ts
    ├── format.test.ts
    ├── builtins.test.ts
    ├── tui.test.ts         — 子进程跑真实 Ink fixture
    └── fixtures/tui.tsx    — 补全按键、Esc、/clear、状态栏标签、运行中拒绝
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 模块边界 | `src/commands/` 独立，经 CommandUI 操作界面 | 满足 N2，命令可脱离 Ink 单测；新增命令不改界面层（N7） |
| 命令类型约束 | 判别联合 RunCommand / PromptCommand，register 再做运行时兜底 | 编译期就拦住「提示词类缺模板」，运行时兜底覆盖 AC1 |
| 是否接受参数 | 由 argHint 是否存在决定 | 少一个字段，避免「有提示却不收参数」的矛盾 |
| 冲突检测顺序 | 小写后先查冲突，再校验格式 | 大小写不同的撞名也报出双方（AC2） |
| 启动失败 | main 在 render 前构造注册中心，捕获后 exit 1；App 自带缺省兜底 | 不进入界面（F2）；旧测试与 fixture 无需传参 |
| 提示词类的展示与历史 | Message 加可选 `display`，content 存展开文本、display 存原命令；恢复时优先显示 display | 模型需要展开文本，用户恢复会话时要看到当时敲的命令；可选字段向后兼容旧存档，适配器不读它所以不会泄给模型 |
| 补全状态归属 | 放在 InputBox 内，匹配逻辑是纯函数 | 与 ↑↓ 翻历史、光标同处一个 useInput，避免两个组件抢键 |
| Esc 冲突 | InputBox 每次渲染把 open 写进共享 ref，App 的中断判断先读它 | Ink 的多个 useInput 同时收到按键；渲染期写 ref 与处理器执行顺序无关 |
| Enter 初始高亮 | 完全匹配项优先，否则第一项 | `/do`、`/resume` 等完整输入回车行为与现在一致 |
| /clear 刷新静态区 | 写清屏序列 + Static 换 key 重新挂载 | Static 只追加不回收，必须重挂才能从横幅重新输出 |
| /clear 清历史 | 复用 `conversation.restore([])` | 只改内存不写盘；新会话由 startNewSession 接管存档 |
| 运行中普通文本 | 仍拒绝并保留输入，文案改为「仅支持 /resume 等斜杠命令；可按 Esc 中断」 | 运行中已放开多条命令；保留子串「仅支持 /resume」，现有 fixture 断言不变 |
| 档位标签 | MODE_TAGS 放 format.ts，app 的 MODE_INFO 引用它 | 状态栏与 /status 共用一份，避免漂移 |
| sendUserMessage 返回值 | boolean | 客户端未就绪时与普通消息一样保留输入 |
| refreshStatus | React 实现里只自增 tick 强制重渲染 | 接口按 spec 保留；状态变更都经 setState，本实现里几乎是空操作 |

## spec 覆盖

| spec | 落点 |
|---|---|
| F1、F2、N6 | types.ts、registry.ts、main.tsx |
| F3 | parser.ts |
| F4 | app.tsx handleSubmit + dispatcher |
| F5、F6、F7、N4 | dispatcher.ts；原命令存档：conversation.ts、session.ts、resume.ts |
| F8、N2 | types.ts CommandUI + app.tsx commandUI |
| F9 | format.ts MODE_TAGS + app.tsx |
| F10、F11 | completion.ts + input.tsx + registry.resolve |
| F12 | builtins/* + format.ts |
| N1 | 本地命令不触网；suggest 为同步纯函数 |
| N3 | 旧分支等价迁入 commandUI；全量回归 |
| N5 | format.ts endpointHost；快照不含 api_key |
| N7 | builtins/ 新增一条 + index.ts 登记 |
