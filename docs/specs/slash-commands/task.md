# 斜杠命令系统 Tasks

> 依据已批准的 spec.md、plan.md。命令均在 `typescript/` 下执行。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/commands/types.ts` | CommandDef / CommandUI / 快照 / ParsedInput / DispatchResult / Suggestion |
| 新建 | `src/commands/registry.ts` | CommandRegistry、CommandRegistryError |
| 新建 | `src/commands/parser.ts` | parseInput |
| 新建 | `src/commands/completion.ts` | suggest |
| 新建 | `src/commands/dispatcher.ts` | dispatch、expandPrompt |
| 新建 | `src/commands/format.ts` | MODE_TAGS、endpointHost、formatHelp/Status/Session/Memory/Permission |
| 新建 | `src/commands/builtins/info.ts` | help、status、session、memory、permission |
| 新建 | `src/commands/builtins/session.ts` | clear、compact、resume、exit |
| 新建 | `src/commands/builtins/mode.ts` | plan、do、accept-edits、bypass |
| 新建 | `src/commands/builtins/review.ts` | review |
| 新建 | `src/commands/builtins/index.ts` | BUILTIN_COMMANDS、createBuiltinRegistry、createCommandsOrExit |
| 修改 | `src/conversation/conversation.ts` | Message.display、addUserMessage(content, display?) |
| 修改 | `src/memory/session.ts` | isMessage 校验 display |
| 修改 | `src/memory/resume.ts` | displayMessages 优先用 display |
| 修改 | `src/tui/app.tsx` | 档位标签、startNewSession、startAgentTurn、commandUI、分流、/clear、Esc 守卫 |
| 修改 | `src/tui/input.tsx` | 补全列表与按键 |
| 修改 | `src/main.tsx` | 启动期构造注册中心，失败退出 |
| 新建 | `tests/commands/fake-ui.ts` | 记录调用的 CommandUI 假实现 |
| 新建 | `tests/commands/{registry,parser,completion,dispatcher,format,builtins,startup}.test.ts` | 单元测试 |
| 新建 | `tests/commands/tui.test.ts` + `fixtures/tui.tsx` | 真实 Ink 子进程测试 |
| 修改 | `tests/conversation.test.ts`、`tests/memory/session.test.ts`、`tests/memory/resume.test.ts` | display 字段用例 |

> 对 plan 的一处补充：`createCommandsOrExit()` 把 main 里的 try/catch 收进 builtins/index.ts，main 只调这一行。
> 这样 AC2 的「退出码非零」能用子进程直接测到 main 实际走的那段代码（main.tsx 有顶层副作用，不能被 import）。

---

## T1: 命令类型定义

**文件：** `src/commands/types.ts`
**依赖：** 无
**步骤：**
1. 按 plan「核心数据结构」写出 CommandKind、BaseCommand（不导出）、RunCommand、PromptCommand、CommandDef、CommandContext、ParsedInput、DispatchResult、Suggestion。
2. 按 plan「CommandUI」写出 CommandUI、UsageSnapshot、StatusSnapshot；从 `permission/types` 引 PermissionMode、RuleSet，从 `memory/notes` 引 NoteScope、NoteType，从 `mcp/types` 引 McpServerReport（均 `import type`）。
3. CommandContext.registry 的类型用 `import type { CommandRegistry } from "./registry.js"`（T2 创建前先写好，T2 完成后才能通过类型检查）。

**验证：** T2 完成后 `bun run typecheck` 零错误；在 `src/commands/` 下搜索 `from "ink"` 与 `tui/` 无结果。

## T2: 注册中心

**文件：** `src/commands/registry.ts`、`tests/commands/registry.test.ts`
**依赖：** T1
**步骤：**
1. `export class CommandRegistryError extends Error`，构造时设 `name = "CommandRegistryError"`。
2. `CommandRegistry` 私有 `defs: CommandDef[]` 与 `index: Map<string, CommandDef>`。
3. `register(def)` 按 plan 顺序：① name 与每个 alias 转小写逐个查 index 及本条已收集的键，重复 → `命令名冲突：/<键> 同时属于 /<已有主名> 与 /<本条主名>`；② 每个原值匹配 `/^[a-z0-9-]+$/`，否则 `命令 /<name> 的名称或别名不合法：<值>`；③ local/ui 无 `run` 函数、prompt 无非空 `template` → `命令 /<name> 缺少执行逻辑或模板`；④ 写入 defs 与 index。
4. `resolve(token)`：`index.get(token.toLowerCase())`。
5. `list(includeHidden = false)`：过滤 hidden 后按 name 字母序返回副本。
6. 测试用例：正常登记与按别名查找；`/HELP` 大小写查找；名称撞名称、名称撞别名、别名撞别名、`Q` 与 `q`（报错信息同时含两个主名）；同一条命令自身 name 与 alias 重复；大写名、含空格名、空串名；kind 为 prompt 但 template 为空（用 `as unknown as CommandDef` 绕过类型）；list 排序且默认排除 hidden、`list(true)` 含 hidden。

**验证：** `bun test tests/commands/registry.test.ts` 全绿；`bun run typecheck` 零错误。

## T3: 解析器

**文件：** `src/commands/parser.ts`、`tests/commands/parser.test.ts`
**依赖：** T1
**步骤：**
1. `parseInput(raw)`：`const text = raw.trim()`；空 → `{ type: "empty" }`；不以 `/` 开头 → `{ type: "text", text }`；否则匹配 `/^\/(\S*)\s*([\s\S]*)$/`，返回 `{ type: "command", name: m[1].toLowerCase(), args: m[2].trim() }`。
2. 测试用例：`""`、`"   \n "` → empty；`"hello /x"` → text；`"/HELP"` → name help、args 空；`"/help   status "` → args `status`；`"/review a\nb"` → name review、args `a\nb`；`"/"` → name 空串；`"/ foo"` → name 空串、args foo。

**验证：** `bun test tests/commands/parser.test.ts` 全绿。

## T4: 补全匹配

**文件：** `src/commands/completion.ts`、`tests/commands/completion.test.ts`
**依赖：** T2
**步骤：**
1. `suggest(text, registry)`：`text` 不匹配 `/^\/\S*$/` → `[]`；`prefix = text.slice(1).toLowerCase()`；对 `registry.list(false)` 过滤「name 或任一 alias `startsWith(prefix)`」，映射为 `{ name, description }`。
2. 测试用例（用测试内自建的小注册中心，含一条 hidden）：`/` 返回全部非隐藏；`/s` 返回 session、status 两项且有序；`/q` 经别名命中 exit 且只出现一次；`/zz` 空；`/st ` 与 `/a\nb` 空；hidden 命令即使前缀命中也不出现；`/S` 大写也能命中。

**验证：** `bun test tests/commands/completion.test.ts` 全绿。

## T5: CommandUI 假实现

**文件：** `tests/commands/fake-ui.ts`
**依赖：** T1
**步骤：**
1. `export function fakeUI(overrides?: Partial<CommandUI>)` 返回 `{ ui, calls }`：`calls` 是 `Array<{ method: string; args: unknown[] }>`，ui 的每个方法先把调用推入 calls 再返回默认值。
2. 默认值：`sendUserMessage` → true；`compact` → `Promise.resolve()`；`getUsage` → 全 0、contextWindow 128000、usedTokens 1000；`snapshot` → provider `{ name: "test", protocol: "openai-compat", model: "m", baseUrl: "https://api.example.com/v1?key=SECRET" }`、档位 default、四层空规则、会话 `{ id: "20260101-000000-abcd", messageCount: 3, path: "/w/.mewcode/sessions/20260101-000000-abcd.jsonl" }`、两级空记忆、mcp 空数组。
3. 导出辅助 `messages(calls)`：取出所有 showMessage 的文本。

**验证：** 被 T6 起的测试 import 后 `bun run typecheck` 零错误。

## T6: 分发器

**文件：** `src/commands/dispatcher.ts`、`tests/commands/dispatcher.test.ts`
**依赖：** T2、T3、T5
**步骤：**
1. `expandPrompt(def, args)`：无参返回 template；有参返回 `` `${template}\n\n${def.argLabel ? `${def.argLabel}：${args}` : args}` ``。
2. `dispatch(raw, { registry, ui, busy })` 按 plan 流程 1–6 实现；`report(error)` 统一显示 `命令 /<name> 执行失败：<message>`（isError=true）。
3. run 返回 Promise 时挂 `.catch(report)`，不 await；dispatch 本身保持同步返回。
4. 测试用例（测试内自建注册中心：一条 local、一条 ui 不可运行中、一条 prompt、一条同步抛错、一条异步 reject）：
   - 普通文本 → not-command，calls 为空。
   - `/nope` → done，消息含「未知命令：/nope」与「/help」；`/` → 未知命令提示。
   - busy 时不可运行中命令 → rejected，消息含「Agent 运行中」，run 未执行；busy 时可运行中命令照常执行。
   - 无 argHint 的命令带参数 → done，消息含其 usage，run 未执行。
   - prompt 命令带参 → sendUserMessage 的 display 为原输入、prompt 含模板与「审查范围：x」；sendUserMessage 返回 false → rejected。
   - 同步抛错与异步 reject（`await Bun.sleep(0)` 后检查）→ 显示「执行失败」错误消息，dispatch 不抛。
   - `/HeLp` 大写 → 执行同一命令。

**验证：** `bun test tests/commands/dispatcher.test.ts` 全绿。

## T7: 格式化

**文件：** `src/commands/format.ts`、`tests/commands/format.test.ts`
**依赖：** T2、T5
**步骤：**
1. `MODE_TAGS`：plan `[PLAN]`、default `[DEFAULT]`、acceptEdits `[ACCEPT-EDITS]`、bypass `[BYPASS]`。
2. `endpointHost(baseUrl)`：空串 → `默认端点`；`try { return new URL(baseUrl).host } catch { return "（地址无法解析）" }`。
3. 按 plan「format.ts 要点」实现 formatHelp、formatStatus、formatSession、formatMemory、formatPermission；每个函数返回多行字符串（`\n` 连接）。
4. 测试用例：
   - endpointHost：带 query 与 userinfo 的 URL 只返回主机名（含端口）；空串；非法串。
   - formatStatus：输出含 provider 名、协议、模型、`[DEFAULT]`、上下文百分比与「MCP 0/0 已连接」；**不含** `SECRET`、`key=`、`https://`；usedTokens 为 null 时含「上下文估算未就绪」。
   - formatHelp：无参列出全部非隐藏命令并带别名；带参 `h` 输出 help 的用法与参数提示；未知 target 输出未知命令提示。
   - formatMemory：两级皆空 → 「暂无记忆」；有条目时分节、含类型中文标签。
   - formatPermission：含档位标签、四层分节、空层「无」、规则行 `allow Bash(git *)`。
   - formatSession：含 ID、消息条数、路径、「/resume」。

**验证：** `bun test tests/commands/format.test.ts` 全绿。

## T8: 内置命令定义与注册

**文件：** `src/commands/builtins/{info,session,mode,review,index}.ts`、`tests/commands/builtins.test.ts`
**依赖：** T6、T7
**步骤：**
1. `info.ts` 导出 `INFO_COMMANDS: CommandDef[]`：help（别名 `h`，argHint `[命令名]`，run 内 `ui.showMessage(formatHelp(registry, args || undefined))`）、status（`formatStatus(ui.snapshot(), ui.getUsage())`）、session、memory、permission；全部 kind local、availableWhileBusy true。
2. `session.ts` 导出 `SESSION_COMMANDS`：clear（ui，busy false → `ui.clearConversation()`）、compact（ui，busy false → `await ui.compact()`）、resume（ui，busy true → `ui.openResume()`）、exit（别名 `quit`、`q`，ui，busy true → `ui.exit()`）。
3. `mode.ts` 导出 `MODE_COMMANDS`：plan→plan、do→default、accept-edits→acceptEdits、bypass→bypass；ui、busy true；run 内 `ui.setPermissionMode(m); ui.refreshStatus()`。
4. `review.ts` 导出 `REVIEW_COMMAND`：prompt、busy false、argHint `[范围]`、argLabel `审查范围`、template 按 plan 文案。
5. `index.ts`：`BUILTIN_COMMANDS = [...INFO_COMMANDS, ...SESSION_COMMANDS, ...MODE_COMMANDS, REVIEW_COMMAND]`；`createBuiltinRegistry(defs = BUILTIN_COMMANDS)` 逐条 register 后返回；`createCommandsOrExit(defs = BUILTIN_COMMANDS)`：try 调 createBuiltinRegistry，catch 时 `console.error(\`Error: ${message}\`)`、`process.exitCode = 1`、`process.exit()`。
6. 测试用例（经 dispatch + fakeUI）：注册无冲突且 `list()` 恰为 14 个主名；`/h` 与 `/help` 输出一致；`/q`、`/quit`、`/exit` 都调 `exit`；四个模式命令各调一次对应的 `setPermissionMode` 与 `refreshStatus`；`/clear`、`/compact`、`/resume` 调对应方法；busy 时 `/clear`、`/compact`、`/review` rejected，`/status`、`/plan`、`/resume`、`/exit` 执行；`/status foo` 显示用法；`/review src/tui` 的 prompt 含「git diff」与「审查范围：src/tui」；14 条命令在 fakeUI 下逐条执行不抛错（AC13）。

**验证：** `bun test tests/commands/builtins.test.ts` 全绿。

## T9: 启动期冲突退出

**文件：** `tests/commands/startup.test.ts`
**依赖：** T8
**步骤：**
1. 测试内用 `Bun.spawn([process.execPath, "-e", <脚本>])` 起子进程；脚本 import `src/commands/builtins/index.ts` 的 `createCommandsOrExit` 与 `BUILTIN_COMMANDS`，传入 `[...BUILTIN_COMMANDS, { ...BUILTIN_COMMANDS[0], name: "status", aliases: [] }]`，之后 `console.log("SHOULD_NOT_REACH")`。
2. 断言：退出码 1；stderr 含「命令名冲突」「/status」；stdout 不含 `SHOULD_NOT_REACH`。
3. 再起一个只传 BUILTIN_COMMANDS 的子进程，断言退出码 0。

**验证：** `bun test tests/commands/startup.test.ts` 全绿。

## T10: 原命令随存档保留

**文件：** `src/conversation/conversation.ts`、`src/memory/session.ts`、`src/memory/resume.ts`，以及 `tests/conversation.test.ts`、`tests/memory/session.test.ts`、`tests/memory/resume.test.ts`
**依赖：** 无
**步骤：**
1. Message 接口加 `display?: string`（注释：仅供界面展示，不发给模型）。
2. `addUserMessage(content: string, display?: string)`：`display !== undefined && display !== content` 时 push `{ role: "user", content, display }`，否则保持原样。
3. `isMessage` 在 return true 前加：`value.display !== undefined && typeof value.display !== "string"` → false。
4. `displayMessages` 推入 `content: message.display ?? message.content`。
5. 测试用例：conversation——带 display 的消息 getMessages 能读出、不同时才写；session——含 display 的记录可 rebuild，display 为数字的行被计入 skippedLines；resume——display 优先显示，无 display 的旧记录照常显示 content。

**验证：** `bun test tests/conversation.test.ts tests/memory/session.test.ts tests/memory/resume.test.ts` 全绿。

## T11: 状态栏英文档位标签

**文件：** `src/tui/app.tsx`
**依赖：** T7
**步骤：**
1. import `MODE_TAGS` from `../commands/format.js`。
2. `MODE_INFO` 四项的 `label` 改为 `MODE_TAGS.plan` 等引用，其余字段不动。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 仍通过。

## T12: 抽出 startNewSession

**文件：** `src/tui/app.tsx`
**依赖：** 无
**步骤：**
1. 把「`if (!sessionWriterRef.current)` 块」里的逻辑抽成组件内函数 `startNewSession(): string`：生成新 ID（同现有的存在性检查）→ `createWriter(id)` 赋给 sessionWriterRef → `conversationRef.current.setRecorder(writer)` → `sessionReleaseRef.current?.()` → `sessionReleaseRef.current = tryAcquire(sessionLockPath(workDir, id))` → 返回 id。
2. 原 if 块改为 `if (!sessionWriterRef.current) startNewSession();`。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 通过（会话占用与恢复换锁断言不变）。

## T13: 抽出 startAgentTurn

**文件：** `src/tui/app.tsx`
**依赖：** T10
**步骤：**
1. 把 handleSubmit 里「`if (!clientRef.current)` 起到 `void runAgentLoop(text); return true;`」抽成 `startAgentTurn(display: string, prompt: string): boolean`，但**去掉** `setPromptHistory`（改由调用方负责）。
2. 函数内：对话区追加 `{ role: "user", content: display }`；`conversationRef.current.addUserMessage(prompt, display)`；`void runAgentLoop(prompt)`。
3. handleSubmit 原位置改为：`const ok = startAgentTurn(text, text); if (ok) setPromptHistory((p) => [...p, text]); return ok;`。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 通过。

## T14: 构造 commandUI

**文件：** `src/tui/app.tsx`
**依赖：** T8、T12、T13
**步骤：**
1. props 加 `commands?: CommandRegistry`；组件内 `const fallbackRef = useRef<CommandRegistry | null>(null)`，`const registryOfCommands = commands ?? (fallbackRef.current ??= createBuiltinRegistry())`。
2. 新增 state `statusTick`（只用于 refreshStatus 强制重渲染）。
3. 在 handleSubmit 之前构造 `const commandUI: CommandUI`，按 plan 逐项实现：showMessage、sendUserMessage（→ startAgentTurn）、setPermissionMode（→ switchPermissionMode）、getUsage、refreshStatus、compact（原 /compact 分支包成 async 函数，返回 Promise）、openResume（原 /resume 分支）、exit（原 /exit 分支）、snapshot。clearConversation 先写成调用 T15 将实现的 `clearConversation()` 函数。
4. snapshot 的 provider 只取 name、protocol、model、`base_url`；memory 用两个 `new MemoryStore(memoryDir(scope, workDir, homeDir)).list()` 映射为 `{ name, type, description }`；session.path 用 `join(sessionsDir(workDir), \`${id}.jsonl\`)`。

**验证：** T15 完成后 `bun run typecheck` 零错误。

## T15: /clear 实现

**文件：** `src/tui/app.tsx`
**依赖：** T14
**步骤：**
1. 新增 state `staticKey`（初值 0）；`const { write } = useStdout()`（import 自 ink）。
2. 实现 `clearConversation()`：`conversationRef.current.restore([])`；`compactorRef.current?.resetFailures()`；`compactorRef.current?.estimator.resetAnchor()`；`completedToolIdsRef.current.clear()`；`committedIndexRef.current = 0`；四个 Token state 置 0；`setError(null)`、`setCompletionMark("")`、`setStreamingText("")`；`const id = startNewSession()`；`modeTrackerRef.current.setMode(mode)`；`write("\x1b[2J\x1b[3J\x1b[H")`；`setStaticKey((k) => k + 1)`；`setMessages([{ role: "system", content: \`已清空对话，开始新会话 ${id}（旧会话可用 /resume 找回）\` }])`。
3. `<Static items={staticItems}>` 改为 `<Static key={staticKey} items={staticItems}>`。

**验证：** `bun run typecheck` 零错误。

## T16: handleSubmit 分流

**文件：** `src/tui/app.tsx`
**依赖：** T15
**步骤：**
1. 删除 handleSubmit 中 `/resume`、`/exit`、`/compact`、`/plan`、`/do`、`/accept-edits`、`/bypass` 七个 if 分支（逻辑已在 commandUI 里）。
2. 新流程：maintenance → false；`const result = dispatch(text, { registry: registryOfCommands, ui: commandUI, busy: activityRef.current === "agent" })`；done → `setPromptHistory` 追加 text、返回 true；rejected → false；not-command 且 agent 运行中 → `addNotice("Agent 运行中，仅支持 /resume 等斜杠命令；可按 Esc 中断")`、false；否则走 T13 的 startAgentTurn 路径。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 通过（含「仅支持 /resume」「暂无历史会话」「/exit 退出」断言）。

## T17: InputBox 补全列表

**文件：** `src/tui/input.tsx`
**依赖：** T1
**步骤：**
1. props 加 `suggest?: (text: string) => Suggestion[]`、`suggestionsOpenRef?: { current: boolean }`。
2. state 加 `highlight`（number）、`dismissed`（boolean）；`useEffect(() => { setDismissed(false); setHighlight(-1) }, [lines])`（-1 表示「用初始高亮」）。
3. 派生：`text = lines.join("\n")`；`items = suggest?.(text) ?? []`；`open = items.length > 0 && !dismissed`；`exact = items.findIndex((i) => "/" + i.name === text.toLowerCase())`，为 -1 时取 0；`current = highlight >= 0 ? Math.min(highlight, items.length - 1) : exact`。（别名完全匹配时列表里只剩该命令一项，下标 0 即正确。）
4. 渲染期写 `if (suggestionsOpenRef) suggestionsOpenRef.current = open`；`useEffect(() => () => { if (suggestionsOpenRef) suggestionsOpenRef.current = false }, [])`。
5. useInput 开头（disabled 判断之后）插入 open 分支：↑ → `setHighlight(Math.max(0, current - 1))`；↓ → `setHighlight(Math.min(items.length - 1, current + 1))`；Tab 且非 Shift → `setLines([\`/${items[current].name} \`])`、光标到行尾；Enter（非 Shift/Ctrl）→ `if (onSubmit("/" + items[current].name))` 清空输入与历史下标；Esc → `setDismissed(true)`。每个分支处理后 return。
6. 渲染：输入框 Box 之后，open 时逐项输出 `<Text color={i === current ? brand.primary : brand.muted}>{i === current ? "❯" : " "} /{name}  {description}</Text>`。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 通过（完整输入 `/resume`、`/exit` 回车仍执行原命令）。

## T18: Esc 守卫与接线

**文件：** `src/tui/app.tsx`
**依赖：** T16、T17
**步骤：**
1. `const suggestionsOpenRef = useRef(false)`。
2. Esc 中断分支条件改为 `key.escape && isStreaming && !suggestionsOpenRef.current`。
3. `<InputBox … suggest={(t) => suggest(t, registryOfCommands)} suggestionsOpenRef={suggestionsOpenRef} />`。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 通过。

## T19: main.tsx 启动期注册

**文件：** `src/main.tsx`
**依赖：** T8、T14
**步骤：**
1. import `createCommandsOrExit`。
2. 在 loadConfig 的 try/catch 之后、隐藏光标之前：`const commands = createCommandsOrExit();`。
3. render 的 `<App … commands={commands} />`。

**验证：** `bun run typecheck` 零错误；`bun test tests/commands/startup.test.ts` 通过。

## T20: 真实 Ink 测试——补全与状态栏

**文件：** `tests/commands/fixtures/tui.tsx`、`tests/commands/tui.test.ts`
**依赖：** T18
**步骤：**
1. 照 `tests/memory/fixtures/tui.tsx` 搭骨架：`fixture()` 临时目录、`Bun.serve` 假 SSE provider（记录请求、`slow` 开头的请求挂起到手动放行）、PassThrough stdin/stdout、`render(<App … />)`、`until()`、`send()`；结束打印 `TUI_COMMANDS_OK`。
2. 场景：启动后输出含 `[DEFAULT]`；`/plan` 回车 → `[PLAN]`；Shift+Tab（`\u001b[Z`）→ `[ACCEPT-EDITS]`；`/bypass` 回车 → `[BYPASS]`；`/do` 回车 → `[DEFAULT]`。
3. 场景：输入 `/s` 不回车 → 输出含 `/session` 与 `/status`；↓ 后 Tab → 输入框内容为 `/status `、列表消失；回车 → 输出含 `MCP`（/status 结果）。
4. 场景：输入 `/qu` → 列表含 `/exit`；Esc 收起后输入框仍为 `/qu`；退格清空。
5. 场景：`/foo` 回车 → 含「未知命令：/foo」，假 provider 请求数不变；↑ → 输入框出现 `/foo`。
6. `tui.test.ts` 照 memory 的写法以子进程运行 fixture，断言退出码 0、stderr 空、stdout 含 `TUI_COMMANDS_OK`。

**验证：** `bun test tests/commands/tui.test.ts` 通过。

## T21: 真实 Ink 测试——运行中、/review、/clear、恢复

**文件：** `tests/commands/fixtures/tui.tsx`
**依赖：** T20
**步骤：**
1. 发 `slow-1` 使 Agent 挂起；输入 `/clear` 回车 → 含「Agent 运行中，请稍后或按 Esc 中断」；`/status` 回车 → 正常输出；输入 `/s` 后 Esc → 列表收起且**未**出现「本轮已中断」；放行请求。
2. `/review src/tui` 回车 → 最后一次请求的最后一条 user 消息含「git diff」与「审查范围：src/tui」；对话区显示 `/review src/tui`。
3. 记下当前会话 ID（`listSessions`）；`/clear` 回车 → 含「已清空对话，开始新会话」；新 ID 与旧 ID 不同；再发 `hi` → 请求里不含 review 模板文本（历史已清空）。
4. `/resume` 回车 → 选择旧会话 → 对话区显示 `/review src/tui` 且不显示模板首句；再发 `recall` → 请求历史中含模板文本；假 provider 收到的所有请求体 JSON 均不含 `"display"` 键。
5. 最后 `/exit` 退出。

**验证：** `bun test tests/commands/tui.test.ts` 通过。

## T22: 全量回归

**依赖：** T1–T21
**步骤：** 依次运行 `bun run typecheck`、`bun test`。

**验证：** typecheck 零错误；`bun test` 全部通过（基线 332 + 新增用例）。

## T23: 端到端手工验收

**依赖：** T22
**说明：** 本机无 tmux（Windows 原生未安装，WSL 内也未安装），无法按 CLAUDE.md 的方式在 tmux 里跑。改为：用户在真实终端执行 `bun run start`，我给出逐项操作脚本，对照 checklist.md 的端到端场景观察。若用户希望用 tmux，需先在 WSL 中安装 tmux 并确认 bun 在 WSL 中可用。
**步骤：** 按 checklist.md「端到端场景」逐项操作并记录观察结果。

**验证：** checklist.md 端到端场景全部勾选，或未通过项写明现象。

## 执行顺序

```
T1 → T2 → T4
   ↘ T3        ↘
T5 ──────→ T6 → T7 → T8 → T9
T10（可并行）──────────────┐
T7 → T11                   │
T12（可并行）              │
T10 → T13                  │
T8 + T12 + T13 → T14 → T15 → T16
T1 → T17
T16 + T17 → T18 → T19 → T20 → T21 → T22 → T23
```

> 进入开发阶段时，先把 T1–T23 写进仓库根目录的 TASK.md 作为需求锚点（现有的上下文管理清单已全部完成，届时询问是覆盖还是追加）。
