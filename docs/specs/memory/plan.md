# 记忆系统 Plan

> 实现语言：TypeScript（Bun）。对应 spec：`docs/specs/memory/spec.md`。

## 架构概览

新增 `src/memory/` 纯逻辑层（spec N1），分五个模块，TUI 只做装配与展示：

- **instructions**（F1–F3）：三层 `MEWCODE.md` 加载与 `@include` 展开，输出拼接好的指令文本与告警列表。启动时调用一次。
- **session**（F4–F6、F9）：会话 ID 生成、JSONL 追加写入、目录扫描列表、过期清理、JSONL → 历史的纯函数重建。
- **resume**（F7–F8）：恢复编排——读文件、重建、载入对话、按需压缩、追加时间跨度提醒，并产出聊天区要展示的消息。
- **notes**（F10–F11）：单范围笔记仓库（读写删笔记、重写索引）与启动时的索引快照（含 200 行 / 25KB 截断）。
- **updater**（F12–F14、F16）：每轮事件收集、记忆更新 Prompt 构造、模型输出解析、操作执行（持锁 + 指纹校验 + 冲突重试一次）、串行队列。
- **lock**（F15–F17）：跨进程锁原语——`wx` 独占创建锁文件、存活检测、残留锁回收。会话独占与记忆写入互斥都基于它。

并发分两层：同进程内由 MemoryUpdater 的 Promise 链串行；跨进程由 lock 模块的锁文件互斥。

对现有模块的改动：

- **ConversationManager**：增加可选的「历史记录器」挂钩——每有消息入史、每次压缩替换，都通知记录器；增加不触发记录的 `restore()` 供恢复使用。会话写盘由此与历史变化严格同步（方案 A）。
- **Compactor**：增加只读的超线判断，导出摘要前缀与边界文本常量（恢复时的展示过滤要用）。
- **main.tsx**：启动时加载指令与记忆快照、清理过期会话，作为 props 传给 App。
- **app.tsx**：把指令与记忆传入系统提示词；创建会话写入器并挂到对话管理器；`/resume` 命令与选择界面；每轮结束把事件喂给收集器并入队记忆更新。
- **tools/limits.ts**：集中声明全部记忆相关阈值（N6）。

## 核心数据结构

### 阈值常量（`tools/limits.ts` 新增一节）

```ts
export const INSTRUCTION_FILE_NAME = "MEWCODE.md";
export const INCLUDE_MAX_DEPTH = 5;             // F2
export const MEMORY_INDEX_MAX_LINES = 200;      // F11
export const MEMORY_INDEX_MAX_BYTES = 25_000;   // F11
export const SESSION_GAP_REMINDER_MS = 4 * 60 * 60 * 1000; // F8：4 小时
export const SESSION_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // F9：30 天
export const SESSION_LIST_LIMIT = 20;           // F7
export const SESSION_TITLE_MAX_CHARS = 50;      // F6
export const MEMORY_LOCK_WAIT_MS = 2_000;       // F16：等待记忆互斥的上限
export const MEMORY_LOCK_STALE_MS = 30_000;     // F16：记忆互斥持有超过此时长视为残留
export const LOCK_RETRY_INTERVAL_MS = 50;       // F16：抢锁失败后的重试间隔
```

### 锁（lock）

```ts
/** 锁文件内容。 */
export interface LockRecord {
  pid: number;
  ts: number;   // 获取时间（毫秒时间戳）
}

export type Release = () => void;
```

### 指令加载（instructions）

```ts
export interface InstructionSource {
  label: string;      // 「项目根 MEWCODE.md」「项目 .mewcode/MEWCODE.md」「用户级 ~/.mewcode/MEWCODE.md」
  path: string;       // 绝对路径
  root: string;       // @include 的越界根：项目级为 workDir，用户级为 ~/.mewcode
}

export interface InstructionsResult {
  text: string;        // 拼接好的完整段落；三处都缺失时为 ""
  warnings: string[];  // 越界 / 超深度 / 重复或环路 / 文件不存在
}
```

### 会话记录（session）

```ts
/** JSONL 每行一条记录（F5）。 */
export type SessionRecord =
  | { type: "message"; ts: string; message: Message }        // ts 为 ISO 时间
  | { type: "compaction"; ts: string; messages: Message[] }; // 压缩后的完整新历史

export interface SessionInfo {
  id: string;
  title: string;          // 首条用户自然语言消息前 50 字符，换行压成空格；没有时为「（无标题）」
  messageCount: number;   // 有效 message 记录数（不含 compaction 记录、不含坏行）
  lastActive: Date;       // 最后一条有效记录的 ts；无有效记录时取文件 mtime
  inUse: boolean;         // 被其他存活进程占用（F15）
}

export interface RebuildResult {
  messages: Message[];
  summaryCount: number;    // 开头来自压缩记录的消息数（展示时折叠用）
  skippedLines: number;    // 坏行数
  truncatedFrom: number | null; // 工具调用不配对时截断的位置（重建后历史的下标），无截断为 null
  lastTimestamp: Date | null;
}
```

### 历史记录器挂钩（ConversationManager）

```ts
export interface HistoryRecorder {
  onAppend(message: Message): void;     // 每条消息入史时调用
  onReplace(messages: Message[]): void; // 压缩替换整段历史时调用
}
```

### 笔记（notes）

```ts
export type NoteType = "user" | "feedback" | "project" | "reference"; // 用户偏好 / 纠正反馈 / 项目知识 / 参考资料
export type NoteScope = "user" | "project";

export interface Note {
  name: string;         // kebab-case slug，同时是文件名（<name>.md），校验 /^[a-z0-9][a-z0-9-]{0,63}$/
  description: string;  // 一句话完整短事实，也是索引行正文
  type: NoteType;
  body: string;
}
```

笔记文件格式：

```markdown
---
name: prefers-chinese
description: 用户要求所有回复与代码注释使用中文
type: user
---

（正文：细节、原因、适用方式）
```

索引 `MEMORY.md` 每行：`- <description>（<name>.md，<类型中文名>）`。索引始终由扫描笔记目录重新生成，不增量编辑，保证与笔记文件一致。

### 记忆更新（updater）

```ts
export interface TurnDigest {
  userText: string;
  assistantTexts: string[];
  toolNames: string[];   // 去重后的工具名，不含结果（F13）
}

export type MemoryOperation =
  | { op: "upsert"; scope: NoteScope; note: Note }  // 新增或整体更新（同名即更新，F13 去重）
  | { op: "delete"; scope: NoteScope; name: string };

/** 模型输出协议：一个 JSON 对象。空数组即「无变更」。 */
// { "operations": [ { "op": "upsert", "scope": "user", "name": "...", "description": "...", "type": "user", "body": "..." },
//                   { "op": "delete", "scope": "project", "name": "..." } ] }
```

## 模块设计

### instructions（`src/memory/instructions.ts`）

**职责：** F1–F3。
**对外接口：**

```ts
export function instructionSources(workDir: string, homeDir?: string): InstructionSource[];
export function loadInstructions(workDir: string, homeDir: string = homedir()): InstructionsResult;
```

**实现要点：**
- 三个来源按「项目根 → 项目 .mewcode → 用户级」顺序读取；缺失跳过；全部缺失返回 `text: ""`。
- 每个来源输出 `## <label>` 小节，整段以 `# 项目指令` 开头，并附一句「多份指令冲突时，以排在前面的为准」。
- `@include` 判定：逐行扫描，用 ``` / ~~~ 切换代码块状态，代码块内不处理；行 `trim()` 后匹配 `^@(\S+)$`，且路径满足「以 `./` `../` `~/` 开头，或含 `/`，或匹配 `\.[A-Za-z0-9]+$`」才视为引用，否则原样保留（`@Override`）。
- 路径解析：`~/` 展开为 homeDir，其余相对当前文件目录；用现有 `resolveInside(root, absolute)` 做越界判定（穿透符号链接，N8）。
- `visited` 为整次 `loadInstructions` 共享的 realpath 集合，三个顶层文件也登记；命中即跳过并告警「重复引用或环路」。
- 深度：顶层文件为第 0 层，被引用文件逐层 +1，超过 `INCLUDE_MAX_DEPTH` 不展开并告警。
- 所有失败只跳过该行并写入 `warnings`，函数本身不抛异常（N5）。

**依赖：** `tools/paths.ts`（resolveInside）、`tools/limits.ts`。

### lock（`src/memory/lock.ts`）

**职责：** F15–F17 的跨进程锁原语。
**对外接口：**

```ts
export function sessionLockPath(workDir: string, id: string): string;          // <workDir>/.mewcode/locks/sessions/<id>.lock
// 记忆锁路径由 MemoryStore.lockPath 从笔记目录推导，不在本模块重复声明。

/** 抢一次：成功返回释放函数，被存活进程持有返回 null。staleMs 缺省表示只按进程存活判断。 */
export function tryAcquire(path: string, staleMs?: number): Release | null;
/** 在 waitMs 内每 LOCK_RETRY_INTERVAL_MS 重试一次 tryAcquire；超时返回 null。 */
export async function acquire(path: string, waitMs: number, staleMs?: number): Promise<Release | null>;
/** 锁文件存在且持有进程存活（且未超 staleMs），且不是本进程。 */
export function isHeldByOther(path: string, staleMs?: number): boolean;
export function isProcessAlive(pid: number): boolean;
```

**实现要点：**
- 抢锁：`mkdirSync(dirname, recursive)` 后 `writeFileSync(path, JSON.stringify({pid, ts}), { flag: "wx" })`——文件已存在即 `EEXIST`，内核保证只有一个进程创建成功。
- `EEXIST` 时读锁文件：解析失败、`!isProcessAlive(pid)`、或 `staleMs` 给定且 `now − ts > staleMs` → 视为残留，`unlinkSync` 后再抢一次（只再抢一次，失败即返回 null，避免两个进程互删死循环）。
- `isProcessAlive`：`process.kill(pid, 0)`，`ESRCH` 为不存在，`EPERM` 视为存在（已在本机 Bun / Windows 验证 `ESRCH` 与 `EEXIST` 行为）。
- 释放函数只删除内容中 pid 仍是本进程的锁文件，防止误删别人回收后新建的锁；重复调用安全。
- 会话锁不给 `staleMs`：会话可以合法地挂几小时，只按进程存活判断。记忆锁给 `MEMORY_LOCK_STALE_MS`：写入阶段只有毫秒级，超过 30 秒必然是残留。

**依赖：** `tools/limits.ts`。

### session（`src/memory/session.ts`）

**职责：** F4–F6、F9，以及 F8 中的纯重建逻辑。
**对外接口：**

```ts
export function sessionsDir(workDir: string): string;           // <workDir>/.mewcode/sessions
export function newSessionId(now?: Date, exists?: (id: string) => boolean): string;

export class SessionWriter implements HistoryRecorder {
  constructor(readonly id: string, workDir: string, onError?: (message: string) => void);
  onAppend(message: Message): void;     // 追加 message 记录
  onReplace(messages: Message[]): void; // 追加 compaction 记录
}

export function listSessions(workDir: string, excludeId?: string, limit?: number): SessionInfo[];
export function readSessionLines(workDir: string, id: string): string[];
export function rebuildHistory(lines: string[]): RebuildResult;
export function cleanupExpiredSessions(workDir: string, now?: Date): number; // 返回删除数
```

**实现要点：**
- `newSessionId`：`YYYYMMDD-HHMMSS-` + 4 位十六进制随机串（`crypto.randomBytes`）；`exists` 命中时重新生成，杜绝同秒撞车。
- `SessionWriter` 首次写入时才 `mkdir -p` 并创建文件（F4 不留空文件）；每条记录 `appendFileSync(JSON.stringify(record) + "\n")`，同步、单行（N3）。写失败后置失败标记，只调用一次 `onError`，之后静默跳过（N5、AC16）。
- `rebuildHistory`：逐行 `JSON.parse`，结构校验（type、ts、role ∈ user/assistant/system、content 为字符串）不过即计入 `skippedLines`；遇到 compaction 记录则以其 `messages` 为新基线（`summaryCount` 记为基线中摘要消息的条数）并继续；之后做配对检查：从头扫描，助手消息含 `toolUses` 时，下一条必须是含全部对应 `toolUseId` 结果的 user 消息，否则从该助手消息起截断。
- `listSessions`：扫描目录下 `*.jsonl`，逐个读全文现算（30 天清理保证规模可控），`inUse = isHeldByOther(sessionLockPath(id))`，按 `lastActive` 倒序，排除 `excludeId`，取前 `limit` 条。
- `cleanupExpiredSessions`：按文件 mtime 判断，被其他存活进程占用的跳过（F15），`unlinkSync` 失败忽略。
- 会话锁的获取与释放不放在 SessionWriter 里，由 TUI 装配层负责：写入器只管追加，锁的生命周期跟随「当前会话是哪个」。

**依赖：** `conversation/conversation.ts`（Message、HistoryRecorder 类型）、lock、`tools/limits.ts`。

### resume（`src/memory/resume.ts`）

**职责：** F7–F8 的编排。
**对外接口：**

```ts
export interface ResumeOutcome {
  id: string;
  messageCount: number;
  skippedLines: number;
  truncated: boolean;
  compaction: "none" | "done" | "failed";
  gapReminder: string | null;          // 已追加的时间跨度提醒文本
  display: { role: "user" | "assistant" | "system"; content: string }[]; // 聊天区回放
}

export async function resumeSession(options: {
  workDir: string;
  id: string;
  conversation: ConversationManager;
  writer: SessionWriter;          // 指向被恢复会话文件的写入器
  compactor?: Compactor;
  now?: Date;
}): Promise<ResumeOutcome>;

export function formatGap(ms: number): string;                 // 「3 天」「5 小时」
export function displayMessages(messages: Message[], summaryCount: number): ResumeOutcome["display"];
```

**执行顺序：**
1. `readSessionLines` → `rebuildHistory`。
2. `conversation.restore(messages)`（不触发记录），再 `conversation.setRecorder(writer)`。
3. `compactor.estimator.resetAnchor()`；若 `compactor.needsCompaction()` 为真则 `compactManually()`，结果映射为 done / failed。压缩成功会经 `onReplace` 写入一条 compaction 记录。
4. 最后一条记录距 `now` 超过 4 小时：`conversation.addUserMessage(<system-reminder>…)`，经 `onAppend` 写入文件。
5. `displayMessages`：摘要消息折叠为一行「（较早的对话已压缩为摘要）」，跳过边界消息、时间跨度提醒与工具结果消息；助手消息只取文本正文。

**依赖：** session、conversation、context/compactor。

### notes（`src/memory/notes.ts`）

**职责：** F10–F11。
**对外接口：**

```ts
export function memoryDir(scope: NoteScope, workDir: string, homeDir?: string): string;

export class MemoryStore {
  constructor(readonly dir: string);
  get lockPath(): string;        // <dir 的上级>/locks/memory.lock，由目录推导，构造参数不变（F16）
  fingerprint(): string;         // 目录下全部 .md 按文件名排序后「文件名 + 内容」的 sha1（F16）
  list(): Note[];                // frontmatter 解析失败的文件跳过
  read(name: string): Note | null;
  write(note: Note): void;       // 原子写：带随机串的临时文件以 wx 独占创建 → rename（N4、F17）
  delete(name: string): boolean;
  rebuildIndex(): void;          // 扫描全部笔记重写 MEMORY.md（同样原子写）
  readIndex(): string;           // MEMORY.md 原文，缺失为 ""
}

export function truncateIndex(text: string): { text: string; truncated: boolean }; // 200 行 / 25KB
export function loadMemorySnapshot(workDir: string, homeDir?: string): string;     // 系统提示词记忆段
```

**实现要点：**
- frontmatter 用已有依赖 `js-yaml` 解析（N2），只认 `---` 包裹的首段。
- `fingerprint` 覆盖全部笔记文件而不只是 MEMORY.md：只改正文不改描述时索引不变，只比索引会漏掉这种冲突。
- `truncateIndex`：先按行截到 200 行，再按 UTF-8 字节累计截到 25KB（只在行边界截），截断时末尾加「（索引已截断）」。
- `loadMemorySnapshot` 输出：`# 记忆` + 一句「以下是你在以往会话中积累的记忆，处理请求时直接参考；与用户当前明确指示冲突时以用户为准」+ `## 用户级记忆` / `## 项目级记忆` 两节；两份都为空时返回 `""`。

**依赖：** `js-yaml`、`tools/limits.ts`。

### updater（`src/memory/updater.ts`）

**职责：** F12–F14。
**对外接口：**

```ts
export class TurnCollector {
  constructor(userText: string);
  observe(event: AgentEvent): void;   // 收 text / tool_start / done
  digest(): TurnDigest | null;        // 仅当 done.reason === "complete" 时返回，否则 null（F12）
}

export function buildUpdatePrompt(digest: TurnDigest, userIndex: string, projectIndex: string): { system: string; user: string };
export function parseOperations(raw: string): MemoryOperation[] | null; // 不合法返回 null；「无变更」返回 []
export function applyOperations(ops: MemoryOperation[], stores: Record<NoteScope, MemoryStore>): string[]; // 返回实际变更的笔记名

export class MemoryUpdater {
  constructor(client: LLMClient, stores: Record<NoteScope, MemoryStore>, onUpdated?: (names: string[]) => void, lockWaitMs?: number); // lockWaitMs 缺省 MEMORY_LOCK_WAIT_MS，测试可调小
  enqueue(digest: TurnDigest): void;  // 串行：挂到内部 Promise 链尾部，立即返回
  abort(): void;                      // 退出时中止进行中的请求（F14 不等待）
  idle(): Promise<void>;              // 测试用：等队列跑完
}
```

**实现要点：**
- 请求方式与摘要器一致：新建一次性 ConversationManager，`client.stream(conv, [], { signal, reminders: [system] })`——工具列表为空，模型物理上无工具可调（F13）。
- Prompt 包含：四类定义与默认归属、去重 / 合并 / 删除规则、禁止敏感值、两份索引原文及各自「当前 N 行 / M 字节，上限 200 行 / 25KB」、超限时必须合并精简、输出 JSON 协议与「无变更返回空数组」。
- `parseOperations`：截取首个 `{` 到末个 `}` 解析；任一操作字段非法（scope、type 不在枚举、name 不符合 slug 规则）则整体返回 `null`——宁可不写也不写半套。name 校验同时防止路径穿越。
- `applyOperations`：upsert 内容与现有笔记完全相同时不计入变更；delete 不存在的笔记忽略；每个受影响的范围执行一次 `rebuildIndex()`。本函数不加锁，由调用方在持锁状态下调用。
- 单次更新的完整流程（F16，乐观锁）：
  1. 读两份索引，记下 `fingerprints = { user: store.fingerprint(), project: ... }`；
  2. 构造 Prompt、调 LLM（不持锁）、`parseOperations`；`null` 或空数组直接结束；
  3. 按「user → project」顺序对本批涉及的范围 `acquire(lockPath, MEMORY_LOCK_WAIT_MS, MEMORY_LOCK_STALE_MS)`，任一超时则释放已获取的锁并放弃；
  4. 持锁下重算涉及范围的指纹，与第 1 步不一致 → 释放锁；若是首次则回到第 1 步重跑一次，否则放弃；
  5. 一致 → `applyOperations`，`finally` 中按获取的逆序释放锁。
- 队列中任一任务的异常被吞掉（F14 静默），不影响后续任务；`onUpdated` 仅在变更列表非空时调用。

**依赖：** llm/client、conversation、agent/events、notes、lock。

### ConversationManager 改动（`src/conversation/conversation.ts`）

- 新增 `setRecorder(recorder: HistoryRecorder | null)`。
- 所有入史方法（addUserMessage / addAssistantMessage / addAssistantFull / addToolUseMessage / addToolResultMessage / addSystemReminder）收敛到一个私有 `push()`，推入后调用 `recorder?.onAppend`。
- `replaceWithCompacted` 替换后调用 `recorder?.onReplace`。
- 新增 `restore(messages)`：替换历史但不通知记录器。
- `truncateTo` 现仅测试使用，不接记录器（不在 spec 范围内）。

### Compactor 改动（`src/context/compactor.ts`）

- 新增 `needsCompaction(): boolean`：与 `maintain` 同口径的超线判断（不看熔断）。
- 导出 `SUMMARY_PREFIX`（「【历史摘要】」）与 `BOUNDARY_TEXT`，供 `displayMessages` 识别。

### TUI 改动

- **main.tsx**：在 `loadConfig` 之后调用 `loadInstructions`、`loadMemorySnapshot`、`cleanupExpiredSessions`（全部 try/catch 降级），把 `{ instructions, memory, warnings }` 作为 `startup` prop 传入 App。
- **app.tsx**：
  - `buildSystemPrompt(env, { tools, customInstructions: startup.instructions, memory: startup.memory })`——启动快照，会话期间不变（N7）。
  - 启动告警与权限告警同批显示。
  - `sessionWriterRef`：首次渲染创建 `new SessionWriter(newSessionId(), workDir, onError)` 并 `conversation.setRecorder`；`onError` 显示一次「会话存档写入失败：…，本会话不再存档」。
  - `sessionReleaseRef`：同时 `tryAcquire(sessionLockPath(workDir, id))` 占用新会话（新 ID 不可能被占用；失败只是不占用，不影响存档）；`process.on("exit")` 中调用释放函数。
  - client 就绪时同时创建 `MemoryUpdater`（与 Compactor 同处；MemoryStore 的记忆锁路径由目录推导，装配处无需改动），`onUpdated` 追加一条 `system` 消息「已更新记忆：a、b」（chat.tsx 中 system 已按 muted 色渲染）。
  - `runAgentLoop`：新建 `TurnCollector(userText)`，每个事件 `observe`；结束后 `digest()` 非空则 `enqueue`。
  - 运行中输入：`InputBox` 不再随 `isStreaming` 禁用；`onSubmit` 改为返回 `boolean`（是否接受），返回 `false` 时输入框保留内容。`handleSubmit` 在运行中只接受 `/resume`，其余返回 `false` 并提示「Agent 运行中，仅支持 /resume；可按 Esc 中断」。
  - `/resume`：无会话提示「暂无历史会话」（运行中也不中断本轮）；运行中有会话时置 `pendingResumeRef = 列表` 并 `abort()`，`runAgentLoop` 的 finally 收尾后检查 `pendingResumeRef`，非空则 `setResumeList` 弹出列表——复用 Esc 的取消路径，本轮按 cancelled 收尾，不触发记忆更新；空闲时直接进入列表。列表状态渲染 `SessionSelect`；选中后先 `tryAcquire(sessionLockPath(id))`——返回 null 则提示「该会话正在被另一个 MewCode 使用」并结束（历史不变）；成功则释放旧会话锁、更新 `sessionReleaseRef`，再新建指向该 ID 的 SessionWriter，调用 `resumeSession`，把 `display` 追加到聊天区（Ink Static 区不可清屏，先插一行分隔「──── 已恢复会话 <id> ────」），再显示恢复提示（消息数、跳过行数、截断、压缩结果）。
  - `/exit` 与 Ctrl+C：先 `memoryUpdater.abort()` 再退出。
- **session-select.tsx**（新增）：仿 ProviderSelect，↑/↓ 选择、Enter 确认、Esc 取消；每行「标题 · 最后活跃时间 · N 条」，`inUse` 的行追加「· 使用中」并用 muted 色。

### .gitignore

新增 `**/.mewcode/sessions/`（F4）、`**/.mewcode/locks/`（F17）。临时文件写入失败时已在 finally 中删除，不另加忽略规则。项目级 `.mewcode/memory/*.md` 不忽略（N10）。

## 模块交互

**启动：**
```
main.tsx
 ├─ loadInstructions(workDir)        → instructions + warnings
 ├─ loadMemorySnapshot(workDir)      → memory
 ├─ cleanupExpiredSessions(workDir)
 └─ <App startup={...}>
      ├─ new SessionWriter(newSessionId()) → conversation.setRecorder(writer)
      └─ buildSystemPrompt(..., customInstructions, memory) → createClient
           └─ new Compactor(...) / new MemoryUpdater(client, stores)
```

**每轮：**
```
handleSubmit → conversation.addUserMessage ──onAppend──→ SessionWriter（追加一行）
runLoop 事件 ─→ TurnCollector.observe
             └→ 循环内每条入史消息 ──onAppend──→ SessionWriter
                压缩 replaceWithCompacted ──onReplace──→ SessionWriter（compaction 记录）
done(complete) → TurnCollector.digest() → MemoryUpdater.enqueue
                   └（后台串行）stream(无工具) → parseOperations → applyOperations
                                                → rebuildIndex → onUpdated → TUI 提示
```

**恢复：**
```
/resume → listSessions(excludeId=当前) → SessionSelect
选中 → new SessionWriter(选中 ID)
     → resumeSession: readSessionLines → rebuildHistory → conversation.restore
                     → setRecorder(writer) → [needsCompaction → compactManually]
                     → [超 4h → addUserMessage(时间跨度提醒)]
                     → displayMessages → TUI 回放 + 提示
```

## 文件组织

```
typescript/
├── src/
│   ├── memory/
│   │   ├── instructions.ts  — MEWCODE.md 三层加载、@include 展开
│   │   ├── session.ts       — 会话 ID、SessionWriter、列表、重建、过期清理
│   │   ├── resume.ts        — 恢复编排、时间跨度提醒、回放消息
│   │   ├── lock.ts          — 跨进程锁文件、存活检测、残留回收、会话锁路径
│   │   ├── notes.ts         — MemoryStore、索引截断、记忆快照、目录指纹
│   │   └── updater.ts       — TurnCollector、更新 Prompt、解析与执行、串行队列
│   ├── conversation/conversation.ts — 记录器挂钩、restore()
│   ├── context/compactor.ts         — needsCompaction()、导出常量
│   ├── tools/limits.ts              — 记忆阈值常量
│   ├── tui/session-select.tsx       — 会话选择界面
│   ├── tui/input.tsx                — 运行中可输入；onSubmit 返回是否接受
│   ├── tui/app.tsx                  — 装配
│   └── main.tsx                     — 启动加载
└── tests/memory/
    ├── lock.test.ts
    ├── instructions.test.ts
    ├── session.test.ts
    ├── resume.test.ts
    ├── notes.test.ts
    └── updater.test.ts
```

## 技术决策

### 实现补充（2026-10-19）

- 恢复时如果截断了不配对的工具调用，向原文件追加一条修复后的 `compaction` 检查点。否则第二次恢复仍会停在原来的损坏位置，丢掉首次恢复后的新增消息。已有记录保持不变。
- 续写前检查最后一个字节；若崩溃留下无换行的半条记录，先追加换行再写新记录，保证坏行不会吞掉新消息。
- 重建除检查缺失工具结果，也检查孤立工具结果和嵌套字段结构。压缩分界保留完整工具调用与结果，避免生成不可恢复的存档。
- 模型最终回复的思考块同样入史。取消判定同时检查 AbortSignal，以兼容取消后正常结束流的 SDK，保证 `/resume` 走 cancelled 收尾。
- 笔记临时文件采用随机后缀并在 finally 清理；索引截断提示本身计入 200 行 / 25KB 上限。
- 更新器退出时取消当前请求及待执行任务，并忽略迟到结果。恢复与手动压缩期间互斥修改历史。
- `App` 支持注入 `workDir` / `homeDir`，终端交互测试与真实 provider 验证均使用临时项目和临时用户记忆目录。

### 原定决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 写盘时机 | ConversationManager 挂记录器，入史即追加 | 与历史变化严格同步，轮中途崩溃也只丢最后一行（N3）；TUI 批量写做不到 |
| 压缩如何落盘 | 追加 compaction 记录，恢复从最后一条起重建 | 保持纯追加，不重写文件 |
| 恢复时载入历史 | 单独的 `restore()`，不触发记录 | 已在文件里的消息不能再写一遍 |
| 时间跨度提醒的角色 | user 角色 + `<system-reminder>` 包裹 | Anthropic 协议层会丢弃 system 角色历史消息（anthropic.ts），用 user 才能真正送达模型；协议层会把它与下一条用户输入合并，不破坏交替 |
| 恢复后的压缩 | `needsCompaction()` 判断 + `compactManually()` | 要拿到明确的成功 / 失败结果写进恢复提示；`maintain()` 的返回值区分不了「不需要」和「失败」 |
| 恢复的回放 | 追加分隔线后回放，不清屏 | Ink Static 区已写出的内容无法撤回 |
| 运行中 /resume | 先 abort，finally 收尾后再弹列表 | 复用 Esc 的取消路径，历史收尾、cancelled 不触发记忆更新都现成；在 loop 未收尾时换历史会和循环抢写对话 |
| 运行中被拒的输入 | `onSubmit` 返回 false 时输入框不清空 | 用户打了一半的话不丢；为后续「普通消息排队」留好入口 |
| 索引维护 | 每次变更后扫描目录全量重写 | 用户可能手改笔记，全量重建永远一致；笔记数量小，成本可忽略 |
| 笔记名 | kebab-case slug 严格校验 | 名称直接做文件名，校验同时防路径穿越 |
| 模型输出不合法 | 整批丢弃 | 宁可漏记一轮，也不落半套操作 |
| 后台更新并发 | 内部 Promise 链串行 | 两轮更新同时改同一份索引会互相覆盖（F12） |
| 跨进程锁原语 | `wx` 独占创建锁文件 + `process.kill(pid, 0)` 存活检测 | Node/Bun 没有 flock；`wx` 由内核保证原子，跨平台一致；pid 检测让崩溃残留的锁自动失效 |
| 记忆锁的持有范围 | 只锁写入阶段，LLM 调用不持锁 | LLM 调用要几秒到几十秒，持锁会让另一实例长时间等待或超时 |
| 记忆写入冲突 | 乐观锁：发起时记指纹，持锁写入前比对，变了重跑一次 | 不基于过时信息写入；冲突极少，重跑成本可接受；只重试一次避免两个实例互相打断 |
| 指纹范围 | 全部笔记文件的「文件名 + 内容」 | 只改正文时 MEMORY.md 不变，只比索引会漏掉冲突；按内容而非 mtime，同一毫秒内同长度改写也能识别，笔记体量小读全文成本可忽略 |
| 多锁顺序 | 固定先用户级后项目级 | 两个进程按相反顺序加锁会死锁 |
| 会话锁的残留判定 | 只看进程存活，不设时长 | 会话可合法地挂几小时；pid 复用导致误判「使用中」的概率极低，代价只是不能恢复，可接受 |
| 锁文件位置 | 独立的 `.mewcode/locks/` | 不污染 sessions / memory 目录，「sessions 下只有 .jsonl」不变；一条 gitignore 规则即可 |
| 记忆注入 | 启动快照进稳定段 | 会话内提示词字节不变，不破坏缓存（N7） |
| frontmatter 解析 | 复用 js-yaml | 不引入新依赖（N2） |
| 用户目录 | 所有函数接受可选 `homeDir` | 测试用临时目录，不碰真实 `~/.mewcode/`（N9） |
| 阈值位置 | `tools/limits.ts` 新增一节 | 该文件声明「全部资源上限集中在此」（N6） |
