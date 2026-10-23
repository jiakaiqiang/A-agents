# Skill 系统（一期）Plan

> 依据：docs/specs/skills/spec.md（已批准）。实现语言 TypeScript（Bun + Ink），代码在 `typescript/` 下。

## 架构概览

新增 `src/skills/` 模块，不依赖 Ink，也不依赖 commands 模块。

| 组件 | 职责 |
|---|---|
| `skills/types.ts` | Skill 定义、来源、模式、解析结果、加载结果、激活项、独立执行结果 |
| `skills/parser.ts` | 纯函数：frontmatter + 正文 → Skill；`$ARGUMENTS` 替换 |
| `skills/loader.ts` | 三级发现（内部 → 用户 → 项目）、同名覆盖、单文件与目录型冲突、白名单校验、安全读取 |
| `skills/catalog.ts` | 纯函数：稳定段里的 Skill 目录文本、钉住区文本 |
| `skills/manager.ts` | `SkillManager`：持有全部 Skill 与已激活集合，算钉住文本和可用工具集合；转发独立模式运行 |
| `skills/isolated.ts` | 独立模式执行器：截取历史、建子对话、复用 `runLoop` 跑完、取最后一条回复 |
| `skills/load-tool.ts` | 系统级工具 `loadSkill`：模型用它激活 Skill 或运行独立 Skill |
| `skills/builtin/*.md` | commit、review、test 三个样板，和外部 Skill 走同一个解析器 |
| `commands/builtins/skills.ts` | Skill → 斜杠命令的转换与登记；`/skills` 命令 |

现有模块的接入点：

- **Agent 循环**：每次迭代从 `SkillView` 取钉住文本和可用工具集合，按集合过滤下发的工具和延迟目录，并把集合放进工具上下文。
- **工具执行入口 `runTool`**：集合外的工具不执行，返回 `not_allowed`。
- **LLM 适配器**：钉住文本作为请求参数传入，放在系统提示词之后、对话历史之前。
- **命令模块**：Skill 动态登记成斜杠命令；新增 `/skills`；删除原 `/review` 提示词命令。
- **App**：实现新增的 CommandUI 方法、注入独立模式运行器、渲染子对话事件；`/clear`、`/resume` 时停用全部 Skill。
- **main.tsx**：MCP 连接完成后加载 Skill、登记命令、注册 `loadSkill`，再 render。

依赖方向：`commands → skills → agent → tools`。`SkillView` 定义在 `agent/loop.ts`，`SkillManager` 按结构实现它，agent 不 import skills，无环。

## 核心数据结构

```ts
// src/skills/types.ts
export type SkillSource = "builtin" | "user" | "project";
export type SkillMode = "shared" | "isolated";

export interface SkillDef {
  name: string;
  description: string;
  tools: string[] | null;   // null 表示不收窄
  mode: SkillMode;
  history: number;          // 仅 isolated 有意义；shared 恒为 0
  model?: string;           // 仅 isolated
  body: string;             // 未替换参数的 SOP 正文
  source: SkillSource;
  path: string;             // 来源文件，用于告警和 /skills 展示
}

export type ParseResult =
  | { ok: true; skill: SkillDef; warnings: string[] }  // 未知字段、共享模式写了 history/model 只告警
  | { ok: false; reason: string };

export interface SkillLoadResult {
  skills: SkillDef[];                       // 已覆盖、已校验，按名字排序
  warnings: string[];                       // 每条都带路径和原因
  counts: Record<SkillSource, number>;      // 启动摘要用（覆盖与校验之后的数量）
}

export interface ActiveSkill {
  skill: SkillDef;
  expanded: string;                         // 替换参数后的全文，即钉住内容
}

export interface IsolatedOutcome {
  ok: boolean;                              // 中断或失败时为 false
  text: string;                             // 子对话最后一条回复，或失败说明
}

export type IsolatedRunner = (skill: SkillDef, args: string, context: ToolContext) => Promise<IsolatedOutcome>;
```

```ts
// src/agent/loop.ts
/** Agent 循环看 Skill 状态的窄接口：每次迭代读一次，模型中途激活的 Skill 下一次迭代就生效。 */
export interface SkillView {
  pinnedText(): string;                         // 没有激活时为 ""
  allowedTools(): ReadonlySet<string> | null;   // null 表示不收窄
}
```

## 模块设计

### parser.ts
**职责：** 解析单个 Skill 文本；参数替换。
**对外接口：**
```ts
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function parseSkill(text: string, meta: { dirName: string; source: SkillSource; path: string }): ParseResult;
export function expandBody(body: string, args: string): string;
```
- 去 BOM，按 `^---\n…\n---\n` 切出 frontmatter，用 js-yaml `load` 解析（v4 默认 schema 不执行代码）。
- 校验规则按 spec F1：`name` 必须匹配 `SKILL_NAME_PATTERN` 且等于 `dirName`；`description` 非空单行；`tools` 为字符串数组；`mode` 为 `shared | isolated`；`history` 为非负整数；`model` 为非空字符串；正文 trim 后非空。
- 已知字段集合外的键 → 告警「未知字段 x，已忽略」。共享模式写了 `history`/`model` → 告警并忽略。
- `expandBody`：args 先 trim；正文含 `$ARGUMENTS` 时全部替换；不含且 args 非空时追加 `\n\n${args}`。

### loader.ts
**职责：** 三级发现、覆盖、校验。
**对外接口：**
```ts
export function builtinSkillsDir(): string;   // fileURLToPath(new URL("./builtin", import.meta.url))
export function loadSkills(options: {
  workDir: string; homeDir: string;
  availableTools: ReadonlySet<string>;      // 内置 + 已连 MCP + 延迟登记的 MCP + "loadSkill"
  builtinDir?: string;                      // 测试可注入
}): SkillLoadResult;
```
- 读取顺序：内部 → 用户 `~/.mewcode/skills` → 项目 `<workDir>/.mewcode/skills`，后读的覆盖先读的（Map 按名字覆盖）。
- 每个目录只看第一层：`<名字>.md` 文件、`<名字>/SKILL.md`。其他文件、子目录里没有 SKILL.md 的，静默忽略。
- 同层 `<名字>.md` 与 `<名字>/SKILL.md` 并存 → 用目录型，告警。
- 安全读取：`realpathSync` 解析后必须仍在该 skills 目录的 realpath 之内，否则跳过并告警；`statSync().size > SKILL_FILE_MAX_BYTES` 跳过并告警；读取异常跳过并告警。
- 覆盖完成后做白名单校验：`tools` 里有不在 `availableTools` 里的名字 → 跳过，告警列出不存在的工具名和路径。
- 目录不存在视为空，不告警。

### catalog.ts
**职责：** 生成两段文本。
**对外接口：**
```ts
export function skillCatalogSection(skills: SkillDef[]): string;   // 没有 Skill 返回 ""
export function pinnedSection(active: ActiveSkill[]): string;      // 没有激活返回 ""
```
- 目录（进稳定段的 Skills 段位，`PROMPT_PRIORITY.skills`）：
  ```
  # Skills
  以下 Skill 可用。用户的请求匹配某个 Skill 时，调用 loadSkill({"name": "<名字>", "args": "<参数>"}) 加载其完整指令；用户也可以输入 /<名字> 直接调用。
  - commit: 按约定格式提交当前改动
  - test: 跑测试并汇总失败（独立运行）
  ```
  说明超过 `SKILL_CATALOG_DESC_MAX_CHARS`（80）截断加「…」。
- 钉住区：
  ```
  <active-skills>
  以下 Skill 已激活，按其指令执行，直到用户停用：
  ## Skill: commit
  <替换后的全文>
  </active-skills>
  ```

### manager.ts
**职责：** Skill 运行期状态。
**对外接口：**
```ts
export const LOAD_SKILL_TOOL = "loadSkill";
export class SkillManager implements SkillView {
  constructor(skills: SkillDef[]);
  get(name: string): SkillDef | undefined;
  list(): SkillDef[];
  isActive(name: string): boolean;
  activate(name: string, args: string): ActiveSkill;        // 仅 shared；Map 原位替换，不叠加
  deactivate(name?: string): string[];                      // 不传名字停用全部；返回实际停用的名字
  pinnedText(): string;                                     // pinnedSection(激活顺序)
  allowedTools(): ReadonlySet<string> | null;               // 无激活或任一 tools 为 null → null；否则并集 + loadSkill
  setIsolatedRunner(runner: IsolatedRunner): void;
  runIsolated(name: string, args: string, context: ToolContext): Promise<IsolatedOutcome>; // 没注入 runner 时返回 ok:false
}
```

### isolated.ts
**职责：** 独立模式子对话。
**对外接口：**
```ts
export function recentHistory(messages: Message[], n: number): Message[];
export function runIsolatedSkill(options: {
  skill: SkillDef; args: string; history: Message[];
  client: LLMClient; registry: ToolRegistry; protocol: ProviderProtocol;
  workDir: string; mode: AgentMode; permission?: PermissionGate; signal?: AbortSignal;
}): AsyncGenerator<AgentEvent, IsolatedOutcome>;
export function isolatedToolScope(skill: SkillDef, registry: ToolRegistry): ReadonlySet<string>;
export function resultMessage(name: string, outcome: IsolatedOutcome): string;
```
- `recentHistory`：先取末尾 n 条，丢掉 role 为 system 的消息；起点向后推，直到第一条是不带 toolResults 的 user 消息；末尾如果是带 toolUses 的 assistant（结果还没回来，比如正在执行的 loadSkill 调用），丢掉。n 为 0 返回空。
- 子对话：`new ConversationManager()`（不挂记录器，所以不进存档）→ `restore(recentHistory(...))` → `addUserMessage(expandBody(body, args))`。
- 可用工具：`skill.tools` 存在时就是它的集合；为 null 时是注册表全部工具名 + 延迟工具名，减去 `loadSkill`。用一个固定的 `SkillView`（`pinnedText: () => ""`）传给 `runLoop`。
- 不传 compactor、不传 reminders（计划档约束仍由权限层逐次确认承担）。
- 事件：除 `done` 外原样 yield 给调用方渲染；`done.reason === "complete"` 且 `finalText` 非空 → `{ ok: true, text: finalText }`；其他情况 → `{ ok: false, text: 失败说明 }`；异常同样转成 `ok: false`。
- `resultMessage`：成功 `【Skill test 结果】\n<text>`；失败 `【Skill test 未完成】<text>`。

### load-tool.ts
**职责：** 模型侧入口。
**对外接口：** `export function createLoadSkillTool(manager: SkillManager): Tool;`
- 参数 `{ name: string（必填）, args?: string }`，`readOnly: false`、`system: true`，摘要 `loadSkill(commit)`。
- 名字不存在 → `fail("not_found", "未找到 Skill x。可用：commit、review、test")`。
- shared → `manager.activate`，返回「已激活 Skill commit，完整指令已加入上下文；当前可用工具：Bash、Read、…、loadSkill」。
- isolated → `await manager.runIsolated(name, args, context)`，返回 `resultMessage(...)`；`ok:false` 时用 `fail("exec_failed", …)`。

### 对现有模块的修改

| 文件 | 改动 |
|---|---|
| `llm/client.ts` | `StreamOptions` 加 `pinned?: string` |
| `llm/anthropic.ts` | `buildSystemBlocks(segments, pinned?)`：pinned 非空时追加第三个 text 块，不打 cache_control |
| `llm/openai.ts` | 两个 client 的 system 消息内容改为 `pinned ? systemPrompt + "\n\n" + pinned : systemPrompt` |
| `tools/types.ts` | `Tool` 加 `readonly system?: boolean`；`ToolContext` 加 `allowedTools?: ReadonlySet<string>`；`ToolErrorKind` 加 `"not_allowed"` |
| `tools/registry.ts` | `DefinitionOptions` 加 `only?: ReadonlySet<string>`，按名字过滤 |
| `tools/execute.ts` | `runTool` 入口：`context.allowedTools` 存在且不含 name → `fail("not_allowed", "工具 x 不在当前可用工具中")`，早于懒池补载 |
| `tools/limits.ts` | `SKILL_FILE_MAX_BYTES = 64 * 1024`、`SKILL_CATALOG_DESC_MAX_CHARS = 80` |
| `permission/limits.ts` | `classifyTool`：`tool.system` → `"read"`（任何档位都不询问） |
| `agent/loop.ts` | `LoopOptions.skills?: SkillView`；每次迭代：`allowed = skills?.allowedTools() ?? null`；`definitionsFor(protocol, { only })`；延迟目录只列 allowed 内的条目，allowed 存在且不含 `toolSearch` 时不注入；`collectStream` 传 `pinned`；`runBatches` 的 context 带 `allowedTools`；无效迭代判断改为「全部调用都是未知工具或集合外工具」 |
| `commands/types.ts` | CommandUI 加 `listSkills()`、`deactivateSkills(name?)`、`invokeSkill(name, args, display)`；新增 `SkillListItem` |
| `commands/format.ts` | 新增 `formatSkills(items)` |
| `commands/builtins/index.ts` | 去掉 `REVIEW_COMMAND`，加入 `/skills` |
| `commands/builtins/review.ts` | 删除（由 review Skill 取代） |
| `tui/app.tsx` | 见下方「App 接入」 |
| `main.tsx` | 见下方「启动顺序」 |

```ts
// commands/types.ts
export interface SkillListItem { name: string; description: string; mode: SkillMode; source: SkillSource; active: boolean }
interface CommandUI {
  …
  listSkills(): SkillListItem[];
  deactivateSkills(name?: string): string[];
  invokeSkill(name: string, args: string, display: string): boolean;  // 客户端未就绪返回 false
}

// commands/builtins/skills.ts
export function skillCommand(skill: SkillDef): CommandDef;   // kind "ui"，argHint "[参数]"，availableWhileBusy false，描述后缀「（Skill）」
export function registerSkillCommands(registry: CommandRegistry, skills: SkillDef[]): { accepted: SkillDef[]; warnings: string[] };
export const SKILLS_COMMAND: CommandDef;                    // /skills [off [名字]]，kind "ui"，availableWhileBusy true
```

## 模块交互

### 启动顺序（main.tsx）

```
loadConfig → createCommandsOrExit()（内置命令，已无 /review）
→ McpManager.connectAll(registry)
→ loadSkills({ workDir, homeDir, availableTools: registry 全部名字 + lazyNames + "loadSkill" })
→ registerSkillCommands(commands, skills)      // 与内置命令重名的 Skill 被剔除并告警
→ manager = new SkillManager(accepted)
→ registry.register(createLoadSkillTool(manager))
→ render(<App … skills={manager} skillReport={{ warnings, summary }} />)
```

`skillReport.summary` 例如「已加载 Skill 5 个（内部 3、用户 1、项目 1）」，按 accepted 统计。App 在启动告警的同一个 effect 里输出：告警红色，摘要普通色。App 的 `skills` 不传时用 `new SkillManager([])`，不注册 loadSkill，现有测试不受影响。

App 构建系统提示词时：`buildSystemPrompt(env, { …, skills: skillCatalogSection(manager.list()) })`。目录在会话内不变，进稳定段。

### 共享模式：斜杠调用

```
/commit 修复登录超时 → InputBox → handleSubmit → dispatch
→ registry.resolve("commit") → skillCommand.run({ args, ui })
→ ui.invokeSkill("commit", "修复登录超时", "/commit 修复登录超时")
→ App.invokeSkill：skill.mode === "shared"
   ├─ manager.activate("commit", args)                       // 钉住
   └─ startAgentTurn(display, "执行 Skill commit，参数：修复登录超时")
        → conversation.addUserMessage(prompt, display)        // 存档保留原命令
        → runLoop({ …, skills: manager })
             每次迭代：manager.allowedTools() → definitionsFor({ only })
                       manager.pinnedText() → collectStream({ pinned }) → 适配器系统段第三块
```

### 共享模式：模型调用

```
runLoop 迭代 k：模型调用 loadSkill({ name: "commit", args })
→ runBatches → runTool：allowedTools 含 loadSkill（或为 null）→ 权限分类为 read，直接放行
→ loadSkill.execute → manager.activate → 返回「已激活…」
迭代 k+1：pinnedText 与 allowedTools 已更新，钉住与收窄生效
```

### 独立模式：斜杠调用

```
/test src/auth → dispatch → ui.invokeSkill("test", "src/auth", "/test src/auth")
→ App.runIsolatedTurn(skill, args, display)
   ├─ 对话区显示用户行 display；activity = agent；新建 AbortController；setIsStreaming(true)
   ├─ history = conversation.getMessages()（追加前的快照）
   ├─ client = skill.model ? createClient({ ...provider, model }, segments) : clientRef.current
   ├─ for await (event of runIsolatedSkill({ …, signal })) → renderAgentEvent(event, "[test] ")
   ├─ conversation.addUserMessage(display, display)
   ├─ conversation.addAssistantMessage(resultMessage("test", outcome))
   └─ 对话区显示结果消息；收尾（与 runAgentLoop 的 finally 共用 finishTurn）
```

不进入已激活集合，不钉住，不收窄主对话工具。独立轮不交给记忆整理器（TurnCollector 只收主循环事件）。

### 独立模式：模型调用

```
主 runLoop 执行 loadSkill({ name: "test" })
→ manager.runIsolated(name, args, context)   // context 带主循环的 signal 与 permission
→ App 注入的 runner：同上取 history（末尾悬空的 loadSkill 调用由 recentHistory 丢掉）、选 client，
   for await 渲染事件（前缀 [test]）→ 返回 outcome
→ loadSkill 返回 resultMessage → 作为工具结果回灌主历史
```

主循环在等待这次工具调用期间挂起，所以子对话弹出的确认框与主对话不会同时出现；Esc 中断主 signal 时子对话一起中断。

### 停用

- `/skills off [名字]` → `ui.deactivateSkills(name)` → `manager.deactivate(name)`，显示结果。
- `/clear` → `clearConversation` 里调用 `manager.deactivate()`。
- `/resume` → `handleResume` 成功后调用 `manager.deactivate()`。

### App 接入要点

- `renderAgentEvent(event, prefix)`：从 `runAgentLoop` 的 switch 抽出，主循环传 `""`，子对话传 `"[名字] "`。工具行、notice 加前缀；子对话的 `usage` 事件不更新状态栏；`done` 由调用方处理。
- `finishTurn()`：从 `runAgentLoop` 的 finally 抽出（复位流式状态、activity、处理挂起的 /resume），独立轮共用。
- `segmentsRef`：保存 `buildSystemPrompt` 的结果，独立模式指定 model 时建新 client 用。
- `manager.setIsolatedRunner(...)`：在 client 就绪的 effect 里注入，捕获 ref 而不是 state。

## 文件组织

```
typescript/
├── src/skills/
│   ├── types.ts        — SkillDef、ParseResult、SkillLoadResult、ActiveSkill、IsolatedOutcome、IsolatedRunner
│   ├── parser.ts       — parseSkill、expandBody、SKILL_NAME_PATTERN
│   ├── loader.ts       — loadSkills、builtinSkillsDir
│   ├── catalog.ts      — skillCatalogSection、pinnedSection
│   ├── manager.ts      — SkillManager、LOAD_SKILL_TOOL
│   ├── isolated.ts     — recentHistory、runIsolatedSkill、isolatedToolScope、resultMessage
│   ├── load-tool.ts    — createLoadSkillTool
│   └── builtin/
│       ├── commit.md   — shared，tools [Bash, Read, Glob, Grep]
│       ├── review.md   — shared，tools [Bash, Read, Glob, Grep]
│       └── test.md     — isolated，history 0，tools [Bash, Read, Glob, Grep]
├── src/commands/builtins/
│   ├── skills.ts       — skillCommand、registerSkillCommands、SKILLS_COMMAND
│   └── review.ts       — 删除
├── src/{llm,tools,permission,agent,commands,tui}/… — 见「对现有模块的修改」
├── src/main.tsx
└── tests/skills/
    ├── parser.test.ts  loader.test.ts  catalog.test.ts  manager.test.ts
    ├── isolated.test.ts  load-tool.test.ts  integration.test.ts（loop + 白名单 + 钉住）
    └── fixtures/tui.tsx + tui.test.ts（真实 Ink 子进程）
```

受影响的现有测试：`tests/commands/builtins.test.ts`（命令名列表去掉 review，/review 相关用例改到 skills 测试）、`tests/commands/fake-ui.ts`（补三个方法）、`tests/commands/fixtures/tui.tsx`（/review 段改为用 review Skill：断言对话区显示原命令、请求的 system 里含钉住的 SOP、用户消息是触发语、恢复后显示原命令）。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 钉住区位置 | 系统提示词第三段（Anthropic 第三个 system 块，OpenAI 拼在 system 末尾），不放 reminders | reminders 挂在消息末尾，不满足「历史之前」；放在系统段之后，稳定段与环境段字节不变（N2、AC9） |
| 钉住块缓存 | 第三块不打 cache_control | 缓存断点数不变；激活变化只影响消息级缓存，不影响稳定段缓存 |
| 目录放哪 | 复用稳定段已有的 Skills 段位 | 会话内不变，进稳定段可被缓存；段位早已预留 |
| 白名单拦截 | `runTool` 入口按集合判断，早于懒池补载 | 所有工具调用必经此处；防止模型绕过下发列表硬调或借懒池补载绕过 |
| loadSkill 是否豁免 | 不在 runTool 里按 `system` 豁免，由 manager 把它显式加入集合 | 子对话的集合里不含它，借此禁止嵌套；规则只有「看集合」一条 |
| loadSkill 并发与权限 | `readOnly: false`、`system: true`，权限分类为 read | 不与读工具并发，保证同一时刻最多一个确认框；任何档位都不询问加载本身，子对话里的工具照常判定 |
| 集合外调用算无效迭代 | 是 | 防止模型反复硬调空转到迭代上限 |
| 延迟工具与白名单 | 只列集合内的延迟工具；集合不含 toolSearch 时不注入目录 | 目录引导模型调 toolSearch，集合不含它时注入只会诱导被拦的调用 |
| 子对话上下文管理 | 不挂 Compactor、不挂计划模式 reminder | 子任务预期短；超窗按请求失败回流失败说明；计划档约束由权限层承担 |
| 子对话存档 | 新 ConversationManager 不挂记录器 | 满足「不进主历史、不进存档」，不改存档格式 |
| 摘要来源 | 子对话最后一条回复（finalText） | spec 不做额外摘要请求 |
| 指定 model | 沿用当前 provider，新建一个只换模型名的 client | spec 不做切换 provider |
| Skill 加载时机 | main.tsx 里 MCP 连接之后 | 白名单校验需要 MCP 实际连接结果 |
| 与内置命令重名 | 登记命令阶段剔除 Skill 并告警，manager 只收剔除后的 | 被剔除的 Skill 不进目录、不能被 loadSkill 加载，避免「模型能用、/命令不能用」的不一致 |
| Skill 命令类型 | kind "ui"，调用 `ui.invokeSkill`，不复用 prompt 类 | 共享模式要先钉住、独立模式要走子对话，都不是「展开模板发一条消息」 |
| 「标明是 Skill」 | 命令描述加后缀「（Skill）」 | /help 与补全都显示描述，不用改命令类型结构 |
| `/skills` 运行中可用 | 是 | 列表只读；停用在下次迭代生效，和 Shift+Tab 切档一致 |
| frontmatter 解析 | js-yaml 4 `load` | 项目已依赖；v4 默认 schema 不执行代码（N5） |
| 内置样板位置 | `src/skills/builtin/*.md`，用 `import.meta.url` 定位 | 和外部 Skill 同一套解析；Bun 直接从源码运行 |

## spec 覆盖

| spec | 归属 |
|---|---|
| F1 定义格式 | parser.ts |
| F2 占位符 | parser.ts `expandBody` |
| F3 发现与覆盖 | loader.ts |
| F4 白名单校验 | loader.ts（availableTools 由 main 传入） |
| F5 斜杠命令 | commands/builtins/skills.ts、builtins/index.ts（删 /review） |
| F6 目录注入 | catalog.ts `skillCatalogSection` + App 构建系统提示词 |
| F7 加载工具 | load-tool.ts、permission/limits.ts |
| F8 激活与钉住 | manager.ts、catalog.ts `pinnedSection`、llm 适配器、loop.ts |
| F9 共享斜杠调用 | App `invokeSkill` + `startAgentTurn`（display 机制） |
| F10 工具白名单 | manager.ts `allowedTools`、loop.ts、registry.ts、execute.ts |
| F11 独立模式 | isolated.ts、App `runIsolatedTurn` 与 runner |
| F12 查看与停用 | `SKILLS_COMMAND`、format.ts `formatSkills`、App clear/resume |
| F13 内部样板 | skills/builtin/*.md |
| F14 启动报告 | main.tsx `skillReport` + App 启动 effect |
| N1 | catalog.ts 截断 |
| N2 | 钉住第三段、目录进稳定段 |
| N3 | loader 只读本地 |
| N4 | loader 单文件 try/catch；load-tool / isolated 异常转结果 |
| N5 | loader realpath 校验、大小上限、js-yaml 安全解析 |
| N6 | 白名单只做减法，runTool 仍走 decide；子对话传 permission |
| N7 | skills 缺省时 loop 行为不变；只多 loadSkill 与目录段 |
| N8 | skills/* 不 import ink；isolated 注入假 client |
| N9 | renderAgentEvent 复用主循环渲染，Esc 走同一 signal |
