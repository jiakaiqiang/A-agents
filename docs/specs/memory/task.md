# 记忆系统 Tasks

> 对应 `spec.md` / `plan.md`。所有命令在 `typescript/` 下执行。

## 执行记录（2026-10-19）

- [x] T1–T7：集中阈值、历史记录器、Compactor 接口、指令引用及测试。
- [x] T8–T13：会话存档、列表、清理、恢复与异常修复及测试。
- [x] T14–T20：笔记仓库、启动快照、后台更新队列及测试。
- [x] T21–T27（含 T26b）：gitignore、启动装配、提示词注入、会话选择、运行中输入与 `/resume`。
- [x] T28：`bun test` 373 pass / 0 fail；`bun run typecheck` 通过；保留开发前已有工作区改动。
- [ ] T29：未执行 tmux 手工场景，当前 Windows 无 tmux，WSL 仅有 Docker Desktop。已完成真实 Ink 按键流程测试和真实 provider 脚本验证，具体证据与覆盖边界见 `checklist.md`。

新增验证入口：`bun test tests/memory`、`bun run scripts/verify-memory-real.ts`。后者使用已配置的主模型，只写系统临时目录，不打印密钥与模型回复全文。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/tools/limits.ts` | 新增记忆阈值常量一节 |
| 修改 | `src/conversation/conversation.ts` | HistoryRecorder 挂钩、私有 push、restore() |
| 修改 | `src/context/compactor.ts` | needsCompaction()、导出 SUMMARY_PREFIX / BOUNDARY_TEXT |
| 新建 | `src/memory/instructions.ts` | MEWCODE.md 三层加载、@include 展开 |
| 新建 | `src/memory/session.ts` | 会话 ID、SessionWriter、重建、列表、过期清理 |
| 新建 | `src/memory/resume.ts` | 恢复编排、时间跨度提醒、回放消息 |
| 新建 | `src/memory/notes.ts` | MemoryStore、索引截断、记忆快照 |
| 新建 | `src/memory/updater.ts` | TurnCollector、更新 Prompt、解析执行、串行队列 |
| 新建 | `src/tui/session-select.tsx` | 会话选择界面 |
| 修改 | `src/tui/input.tsx` | 运行中可输入；onSubmit 返回 false 时保留内容 |
| 修改 | `src/main.tsx` | 启动加载指令 / 记忆 / 清理过期会话 |
| 修改 | `src/tui/app.tsx` | 装配：提示词、写入器、更新器、/resume |
| 修改 | `.gitignore`（仓库根） | 忽略 `**/.mewcode/sessions/` |
| 修改 | `tests/conversation.test.ts` | 记录器与 restore 用例 |
| 修改 | `tests/context/compactor.test.ts` | needsCompaction 用例 |
| 新建 | `tests/memory/instructions.test.ts` | F1–F3 |
| 新建 | `tests/memory/session.test.ts` | F4–F6、F8 重建、F9 |
| 新建 | `tests/memory/resume.test.ts` | F7–F8 编排 |
| 新建 | `tests/memory/notes.test.ts` | F10–F11 |
| 新建 | `tests/memory/updater.test.ts` | F12–F14 |

## T1: 阈值常量

**文件：** `src/tools/limits.ts`
**依赖：** 无
**步骤：**
1. 文件末尾新增「记忆系统（memory spec N6）」一节注释。
2. 声明 `INSTRUCTION_FILE_NAME = "MEWCODE.md"`、`INCLUDE_MAX_DEPTH = 5`、`MEMORY_INDEX_MAX_LINES = 200`、`MEMORY_INDEX_MAX_BYTES = 25_000`、`SESSION_GAP_REMINDER_MS = 4h`、`SESSION_EXPIRE_MS = 30d`、`SESSION_LIST_LIMIT = 20`、`SESSION_TITLE_MAX_CHARS = 50`，每个带中文行尾注释标出对应 F 编号。

**验证：** `bun run typecheck` 零错误。

## T2: ConversationManager 记录器挂钩

**文件：** `src/conversation/conversation.ts`
**依赖：** 无
**步骤：**
1. 导出 `HistoryRecorder` 接口（`onAppend(message)`、`onReplace(messages)`）。
2. 新增私有字段 `recorder: HistoryRecorder | null` 与 `setRecorder(recorder)`。
3. 新增私有 `push(message)`：`history.push` 后调用 `recorder?.onAppend(message)`；把 addUserMessage / addAssistantMessage / addAssistantFull / addToolUseMessage / addToolResultMessage / addSystemReminder 中的 `this.history.push` 全部改为 `this.push`。
4. `replaceWithCompacted` 替换后调用 `recorder?.onReplace([...messages])`。
5. 新增 `restore(messages)`：替换历史，不通知记录器。

**验证：** `bun test tests/conversation.test.ts` 原有用例全过；`bun run typecheck` 零错误。

## T3: ConversationManager 测试

**文件：** `tests/conversation.test.ts`
**依赖：** T2
**步骤：**
1. 用例：挂一个收集型假记录器，依次调用六个 add 方法，`onAppend` 收到 6 条且顺序、内容一致。
2. 用例：`replaceWithCompacted` 触发一次 `onReplace`，参数为新历史。
3. 用例：`restore` 替换历史后 `getMessages()` 等于传入值，记录器未收到任何调用。
4. 用例：`setRecorder(null)` 后 add 不再通知。

**验证：** `bun test tests/conversation.test.ts` 全过，新增 4 例。

## T4: Compactor 小改

**文件：** `src/context/compactor.ts`、`tests/context/compactor.test.ts`
**依赖：** 无
**步骤：**
1. `BOUNDARY_TEXT` 改为 `export const`；新增 `export const SUMMARY_PREFIX = "【历史摘要】"`，`runCompaction` 中摘要消息改用该常量拼接（文本不变）。
2. 新增 `needsCompaction(): boolean`，口径与 `maintain` 的超线判断相同（`estimate > window − autoMargin`），不看熔断。
3. 测试：小窗口 + 大历史时为 true，小历史时为 false；熔断打开时仍按估算返回。

**验证：** `bun test tests/context/compactor.test.ts` 全过（原 17 例 + 新增）。

## T5: 指令来源与拼接

**文件：** `src/memory/instructions.ts`
**依赖：** T1
**步骤：**
1. 定义 `InstructionSource`、`InstructionsResult`（字段见 plan.md）。
2. 实现 `instructionSources(workDir, homeDir = homedir())`：按「项目根 MEWCODE.md → 项目 .mewcode/MEWCODE.md → 用户级 ~/.mewcode/MEWCODE.md」返回三项，前两项 `root = workDir`，第三项 `root = <homeDir>/.mewcode`。
3. 实现 `loadInstructions(workDir, homeDir)` 骨架：逐个来源，存在则读入（此步先不展开 include），输出 `# 项目指令` + 冲突说明 + 每个来源一节 `## <label>`；全部缺失返回 `{ text: "", warnings: [] }`。

**验证：** `bun run typecheck` 零错误。

## T6: @include 展开

**文件：** `src/memory/instructions.ts`
**依赖：** T5
**步骤：**
1. 实现私有 `isIncludeLine(line)`：`trim()` 后匹配 `^@(\S+)$`，且路径以 `./` `../` `~/` 开头、或含 `/`、或匹配 `\.[A-Za-z0-9]+$`；返回路径或 null。
2. 实现私有递归 `expand(content, filePath, root, depth, visited, warnings, homeDir)`：逐行扫描，遇 ``` 或 ~~~ 开头的行切换代码块状态；代码块外的引用行：
   - `~/` 展开为 homeDir，其他相对 `dirname(filePath)` 解析为绝对路径；
   - `resolveInside(root, absolute)` 不通过 → 告警「越界引用已拦截」；
   - 文件不存在 → 告警「引用文件不存在」；
   - realpath 已在 `visited` → 告警「重复引用或环路，已跳过」；
   - `depth + 1 > INCLUDE_MAX_DEPTH` → 告警「引用嵌套超过 5 层」；
   - 否则登记 visited，递归展开后替换该行。
   每条告警带「来源文件:行号」。
3. `loadInstructions` 中三个顶层文件先登记 visited，再以 depth 0 调用 `expand`；全程 try/catch，异常转告警。

**验证：** `bun run typecheck` 零错误。

## T7: 指令加载测试

**文件：** `tests/memory/instructions.test.ts`
**依赖：** T6
**步骤：** 每个用例用 `mkdtempSync` 建临时 workDir 与临时 homeDir：
1. 三处都有 → 文本按三层顺序出现，各带 label 与冲突说明（AC1）。
2. 删除中间一份 → 对应节消失；三处都没有 → `text === ""`（AC1）。
3. `@docs/a.md` 展开为 a.md 内容（AC2）。
4. `@Override` 原样保留且 `warnings` 为空（AC2）。
5. 代码块内的 `@docs/a.md` 原样保留（AC2）。
6. A 引用 B、B 引用 A → 各出现一次，产生一条环路告警（AC2）。
7. 7 个文件串成 6 层引用链 → 第 6 层未展开，有超深度告警（AC2）。
8. 项目级 `@../outside.md` → 被拦截并告警（AC2）。
9. 用户级 MEWCODE.md 引用 `~/.mewcode` 之外的文件 → 被拦截并告警（AC2）。
10. 引用不存在的文件 → 告警，函数不抛异常（AC2）。

**验证：** `bun test tests/memory/instructions.test.ts` 全过，10 例。

## T8: 会话 ID 与 SessionWriter

**文件：** `src/memory/session.ts`
**依赖：** T1、T2
**步骤：**
1. 定义 `SessionRecord`、`SessionInfo`、`RebuildResult`（见 plan.md）。
2. 实现 `sessionsDir(workDir)` 与 `newSessionId(now = new Date(), exists = 文件是否存在)`：本地时间 `YYYYMMDD-HHMMSS-` + `randomBytes(2).toString("hex")`，`exists` 命中则重生成。
3. 实现 `SessionWriter implements HistoryRecorder`：首次写时 `mkdirSync(recursive)`；`onAppend` 追加 `{type:"message", ts, message}`，`onReplace` 追加 `{type:"compaction", ts, messages}`；均为 `appendFileSync(JSON.stringify(r) + "\n")`；失败后置 `failed = true` 并仅调用一次 `onError`，之后直接返回。

**验证：** `bun run typecheck` 零错误。

## T9: 历史重建

**文件：** `src/memory/session.ts`
**依赖：** T8、T4
**步骤：**
1. 实现私有 `parseRecord(line)`：JSON 解析 + 结构校验（type ∈ message/compaction、ts 可解析为日期、message.role ∈ user/assistant/system、content 为字符串；compaction.messages 为数组且每项通过同样校验），不合法返回 null。
2. 实现 `readSessionLines(workDir, id)`：读全文按 `\n` 切分，去掉空行。
3. 实现 `rebuildHistory(lines)`：
   - 遇坏行 `skippedLines++`；
   - 遇 compaction 记录：`messages = [...record.messages]`，`summaryCount` = 其中 content 以 `SUMMARY_PREFIX` 开头的消息数；
   - 遇 message 记录：追加；
   - 每条有效记录更新 `lastTimestamp`；
   - 最后做配对检查：助手消息含 `toolUses` 时，下一条须为 user 且其 `toolResults` 覆盖全部 toolUse id，否则 `truncatedFrom = 该下标` 并截断。

**验证：** `bun run typecheck` 零错误。

## T10: 会话列表与过期清理

**文件：** `src/memory/session.ts`
**依赖：** T9
**步骤：**
1. 实现 `listSessions(workDir, excludeId?, limit = SESSION_LIST_LIMIT)`：目录不存在返回 `[]`；对每个 `*.jsonl` 逐行 `parseRecord`，`messageCount` = 有效 message 记录数，`title` = 首个「user 且无 toolResults 且 content 非空」消息的前 50 字符（换行压成空格），无则「（无标题）」，`lastActive` = 最后有效记录 ts，否则 mtime；按 lastActive 倒序，排除 excludeId，截取 limit。
2. 实现 `cleanupExpiredSessions(workDir, now = new Date())`：mtime 早于 `now − SESSION_EXPIRE_MS` 的 `*.jsonl` 删除，单个失败忽略，返回删除数。

**验证：** `bun run typecheck` 零错误。

## T11: 会话测试

**文件：** `tests/memory/session.test.ts`
**依赖：** T10
**步骤：**
1. `newSessionId` 匹配 `/^\d{8}-\d{6}-[0-9a-f]{4}$/`；`exists` 首次返回 true 时得到不同 ID（AC4）。
2. SessionWriter 未写入前文件不存在；写入后每条一行合法 JSON 且含 ts（AC4/AC5）。
3. 挂到 ConversationManager 跑完含工具调用的一组消息（含 thinkingBlocks、toolUses、toolResults）→ 行数与历史一致、字段完整；再 `replaceWithCompacted` → 末尾多一条 compaction，前面各行不变（AC5）。
4. 目录不可写（把 sessions 路径预先建成普通文件）→ `onError` 只调用一次、后续调用不抛（AC16）。
5. `rebuildHistory`：坏行与截断的末行被跳过并计数（AC8/AC15）；末尾工具调用缺结果 → 从该助手消息截断（AC8）；含 compaction → 从最后一条重建且 summaryCount 正确（AC8）。
6. `listSessions`：标题、消息数、lastActive 正确；倒序；排除当前 ID；含坏行时消息数只计有效行；目录下只有 `.jsonl` 文件（AC6）；25 个会话时只返回 20 条（AC7）。
7. `cleanupExpiredSessions`：`utimesSync` 设为 31 天前的被删、29 天前的保留（AC9）。

**验证：** `bun test tests/memory/session.test.ts` 全过。

## T12: 恢复编排

**文件：** `src/memory/resume.ts`
**依赖：** T9、T4
**步骤：**
1. 定义 `ResumeOutcome`（见 plan.md）。
2. 实现 `formatGap(ms)`：≥1 天输出「N 天」，否则「N 小时」。
3. 实现 `displayMessages(messages, summaryCount)`：前 summaryCount 条折叠为一条 system「（较早的对话已压缩为摘要）」；跳过 content 等于 `BOUNDARY_TEXT` 的消息、以 `<system-reminder>` 开头的消息、含 toolResults 的消息、system 角色消息；assistant 只保留 content 非空的。
4. 实现 `resumeSession({ workDir, id, conversation, writer, compactor, now })`，按 plan.md「执行顺序」1–5 步：重建 → `restore` → `setRecorder(writer)` → `estimator.resetAnchor()` + `needsCompaction()` 时 `compactManually()`（结果映射 done/failed，异常也算 failed）→ 超 4 小时追加 `<system-reminder>距上次对话已过去 X，期间文件可能已变化，涉及文件内容时请重新读取。</system-reminder>` 的 user 消息 → 生成 display。

**验证：** `bun run typecheck` 零错误。

## T13: 恢复测试

**文件：** `tests/memory/resume.test.ts`
**依赖：** T12
**步骤：** 用临时 workDir 写入构造好的 JSONL：
1. 正常会话 → conversation 历史与文件一致；之后 `addUserMessage` 追加到同一文件（AC7）。
2. 含坏行 → `skippedLines` 正确（AC8）。
3. 末尾 toolUse 缺结果 → `truncated === true`，历史止于该助手消息之前（AC8）。
4. 小窗口 Compactor + 假客户端返回摘要 → `compaction === "done"`，假客户端收到摘要请求，文件末尾多一条 compaction 记录（AC8）。
5. 假客户端抛错 → `compaction === "failed"`，历史仍被载入（AC8）。
6. `now` 设为最后记录后 5 小时 → 历史末尾为时间跨度提醒且已写入文件；设为 3 小时 → 无提醒（AC8）。
7. `display` 不含工具结果、边界文本与提醒；含摘要折叠行（AC7）。
8. `restore` 过程中不向文件写入任何重复记录（文件行数在恢复前后只因提醒 / 压缩增加）。

**验证：** `bun test tests/memory/resume.test.ts` 全过。

## T14: 笔记仓库

**文件：** `src/memory/notes.ts`
**依赖：** T1
**步骤：**
1. 定义 `NoteType`、`NoteScope`、`Note`，导出 `NOTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/` 与类型中文名映射（用户偏好 / 纠正反馈 / 项目知识 / 参考资料）。
2. 实现 `memoryDir(scope, workDir, homeDir = homedir())`。
3. 实现私有 `atomicWrite(path, text)`：写 `<path>.tmp` 后 `renameSync`。
4. 实现 `MemoryStore`：`list()` 读目录下除 `MEMORY.md` 外的 `*.md`，用 js-yaml 解析 `---` 首段，字段不全或 type 非法的跳过；`read(name)`；`write(note)`（name 不符合模式直接抛错）；`delete(name)`；`rebuildIndex()` 按 type、name 排序生成 `- <description>（<name>.md，<类型中文名>）`，原子写 MEMORY.md；`readIndex()`。

**验证：** `bun run typecheck` 零错误。

## T15: 索引截断与记忆快照

**文件：** `src/memory/notes.ts`
**依赖：** T14
**步骤：**
1. 实现 `truncateIndex(text)`：先截到 `MEMORY_INDEX_MAX_LINES` 行，再按 `Buffer.byteLength` 逐行累计不超过 `MEMORY_INDEX_MAX_BYTES`；发生截断时末尾追加一行「（索引已截断）」，并保证追加后仍在上限内。
2. 实现 `loadMemorySnapshot(workDir, homeDir)`：读两份索引并各自截断；都为空返回 `""`；否则输出 `# 记忆` + 使用说明 + `## 用户级记忆` / `## 项目级记忆`（空的那节省略）。

**验证：** `bun run typecheck` 零错误。

## T16: 笔记测试

**文件：** `tests/memory/notes.test.ts`
**依赖：** T15
**步骤：**
1. write → 文件 frontmatter 含 name / description / type，`list()` 读回一致（AC10）。
2. rebuildIndex → MEMORY.md 每条笔记一行，含 description 与文件名（AC10）。
3. 非法 name（`../x`、`A B`）write 抛错，目录无新文件。
4. 写入后目录中不残留 `.tmp` 文件（AC15）。
5. 手写一份 frontmatter 损坏的文件 → `list()` 跳过它，其余正常。
6. 250 行索引 → 截到 200 行内并含「已截断」；超 25KB 的索引 → 字节数 ≤ 25KB（AC11）。
7. `loadMemorySnapshot`：两份都有 → 含两节标题；只有一份 → 只有对应节；都没有 → `""`（AC11）。

**验证：** `bun test tests/memory/notes.test.ts` 全过。

## T17: TurnCollector 与更新 Prompt

**文件：** `src/memory/updater.ts`
**依赖：** T14
**步骤：**
1. 定义 `TurnDigest`、`MemoryOperation`。
2. 实现 `TurnCollector`：`observe` 处理 `text`（累加到当前段）、`tool_start`（记工具名，并把已累加文本收成一段）、`done`（记 reason，收尾文本）；`digest()` 仅 reason 为 `complete` 时返回，`toolNames` 去重。
3. 实现 `buildUpdatePrompt(digest, userIndex, projectIndex)`：system 写明禁止调用工具、只输出 JSON；user 依次含四类定义与默认归属、去重 / 合并 / 删除规则、禁止敏感值、两份索引原文及「当前 N 行 / M 字节，上限 200 行 / 25KB」、超限必须合并精简、输出协议示例、无变更输出 `{"operations": []}`、本轮对话（用户消息、助手回复、所用工具名）。

**验证：** `bun run typecheck` 零错误。

## T18: 输出解析与操作执行

**文件：** `src/memory/updater.ts`
**依赖：** T17
**步骤：**
1. 实现 `parseOperations(raw)`：取首个 `{` 到末个 `}` 解析；`operations` 非数组、任一项 op / scope / type 不在枚举、name 不匹配 `NOTE_NAME_PATTERN`、upsert 缺 description 或 body → 返回 `null`；合法时返回操作数组（可能为空）。
2. 实现 `applyOperations(ops, stores)`：upsert 与现有笔记内容完全相同时跳过；delete 不存在的忽略；记录实际变更的 name；对有变更的 scope 调用一次 `rebuildIndex()`；返回变更名列表。

**验证：** `bun run typecheck` 零错误。

## T19: MemoryUpdater 串行队列

**文件：** `src/memory/updater.ts`
**依赖：** T18
**步骤：**
1. 实现 `MemoryUpdater(client, stores, onUpdated?)`：内部 `chain: Promise<void>`、`controller: AbortController | null`。
2. `enqueue(digest)`：`chain = chain.then(() => this.run(digest)).catch(() => undefined)`，立即返回。
3. 私有 `run`：新建 AbortController；新建一次性 ConversationManager 放入 user prompt；`client.stream(conv, [], { signal, reminders: [system] })` 收集 `text_delta`；`parseOperations` → null 直接返回；`applyOperations` → 非空时 `onUpdated(names)`。
4. `abort()` 中止当前 controller；`idle()` 返回当前 chain。

**验证：** `bun run typecheck` 零错误。

## T20: 更新器测试

**文件：** `tests/memory/updater.test.ts`
**依赖：** T19
**步骤：** 假客户端按脚本返回文本并记录收到的请求：
1. TurnCollector：complete 返回 digest，含用户文本、助手文本、去重工具名；cancelled / stream_error / max_iterations 返回 null（AC12）。
2. 假客户端收到的 tools 为空数组；请求内容含本轮文本、工具名、两份索引及行数 / 字节数、四类 / 去重 / 敏感值 / 超限 / 无变更等关键字；不含工具结果原文（AC13）。
3. 返回 upsert + delete → 文件与索引正确变化，`onUpdated` 收到变更名（AC10/AC13/AC14）。
4. 返回 `{"operations": []}` → 目录文件内容与 mtime 均不变，`onUpdated` 未调用（AC13）。
5. 对已有笔记 upsert → 不产生新文件，内容被更新（AC13）。
6. 返回非 JSON / 含非法 name → 无任何写入，`onUpdated` 未调用，后续入队仍能执行（AC14）。
7. 假客户端抛错 → 静默，后续入队仍能执行（AC14）。
8. 连续 enqueue 两次，假客户端第一次延迟返回 → 第二次请求在第一次结束后才开始（AC12）。
9. 进行中调用 `abort()` → `idle()` 很快 resolve，无写入（AC14）。

**验证：** `bun test tests/memory/updater.test.ts` 全过。

## T21: .gitignore

**文件：** 仓库根 `.gitignore`
**依赖：** 无
**步骤：**
1. 在工具结果存盘目录一节之后追加注释「会话存档（记忆系统 F4）：含完整工具输出，不入版本库」与 `**/.mewcode/sessions/`。

**验证：** `git check-ignore -v typescript/.mewcode/sessions/x.jsonl` 命中该规则；`git check-ignore typescript/.mewcode/memory/x.md` 无输出（项目笔记不忽略）。

## T22: 启动加载（main.tsx）

**文件：** `src/main.tsx`、`src/tui/app.tsx`
**依赖：** T6、T10、T15
**步骤：**
1. main.tsx 在 `loadConfig` 之后、MCP 连接之前：依次调用 `loadInstructions(process.cwd())`、`loadMemorySnapshot(process.cwd())`、`cleanupExpiredSessions(process.cwd())`，每个单独 try/catch，失败转为一条告警文本。
2. 组装 `startup = { instructions, memory, warnings }`，作为 App 的新 prop `startup` 传入。
3. app.tsx：App props 增加可选 `startup`（缺省为空字符串与空数组）。

**验证：** `bun run typecheck` 零错误；`bun test` 全过。

## T23: 系统提示词与启动告警接入

**文件：** `src/tui/app.tsx`
**依赖：** T22
**步骤：**
1. client 创建处的 `buildSystemPrompt` 第二个参数增加 `customInstructions: startup.instructions`、`memory: startup.memory`。
2. 启动告警 useEffect 中，把 `startup.warnings` 以 `指令文件：<text>`（isError: true）与权限告警、MCP 报告同批追加。

**验证：** `bun run typecheck` 零错误；在临时目录放一份 MEWCODE.md 启动 MewCode，问「本项目有什么规范」，回答体现文件内容。

## T24: 会话写入器接入

**文件：** `src/tui/app.tsx`
**依赖：** T8、T22
**步骤：**
1. 新增 `sessionWriterRef`，用惰性初始化在首次渲染创建 `new SessionWriter(newSessionId(), workDir, onError)`，并 `conversationRef.current.setRecorder(writer)`。
2. `onError` 追加一条 system 错误消息「会话存档写入失败：<原因>，本会话不再存档」。

**验证：** `bun run typecheck` 零错误；启动 MewCode 发一条消息后 `.mewcode/sessions/` 下出现一个 JSONL，行数随对话增长。

## T25: 记忆更新器接入

**文件：** `src/tui/app.tsx`
**依赖：** T19、T23
**步骤：**
1. 新增 `memoryUpdaterRef`；client 就绪处（与 Compactor 同一 then 回调）创建 `new MemoryUpdater(client, { user: new MemoryStore(memoryDir("user", workDir)), project: new MemoryStore(memoryDir("project", workDir)) }, onUpdated)`；切 provider 时先 abort 旧实例。
2. `onUpdated(names)` 追加 system 消息「已更新记忆：a、b」（advanceCommit）。
3. `runAgentLoop` 增加参数 `userText`，开头 `const collector = new TurnCollector(userText)`，事件循环内每个事件 `collector.observe(event)`；循环结束后 `const digest = collector.digest(); if (digest) memoryUpdaterRef.current?.enqueue(digest)`。
4. `handleSubmit` 调用改为 `runAgentLoop(text)`。
5. `/exit` 与 Ctrl+C 分支在 `exit()` 前调用 `memoryUpdaterRef.current?.abort()`。

**验证：** `bun run typecheck` 零错误；`bun test` 全过。

## T26: 会话选择界面

**文件：** `src/tui/session-select.tsx`
**依赖：** T10
**步骤：**
1. 仿 ProviderSelect 实现 `SessionSelect({ sessions, onSelect, onCancel })`：↑/↓ 移动、Enter 调 `onSelect(id)`、Esc 调 `onCancel()`。
2. 每行：`<title> · <lastActive 本地时间 YYYY-MM-DD HH:mm> · <N> 条`；底部提示「↑/↓ 选择，Enter 恢复，Esc 取消」。

**验证：** `bun run typecheck` 零错误。

## T26b: 输入框运行中可用

**文件：** `src/tui/input.tsx`、`src/tui/app.tsx`
**依赖：** 无
**步骤：**
1. `InputBox` 的 `onSubmit` 类型改为 `(text: string) => boolean`；回车时 `if (text && !onSubmit(text)) return;`——未被接受时不清空、不重置历史游标；接受时照旧清空。
2. app.tsx 中 `handleSubmit` 返回 `boolean`：原有各分支末尾返回 `true`；原 `if (isStreaming) return;` 改为：运行中且 `text !== "/resume"` 时追加 system 消息「Agent 运行中，仅支持 /resume；可按 Esc 中断」并返回 `false`。
3. 渲染处 `<InputBox ... disabled={isStreaming} />` 去掉 `disabled`（确认框互斥逻辑保持不变）。

**验证：** `bun run typecheck` 零错误；运行中输入「你好」回车 → 出现提示，输入框里仍是「你好」。

## T27: /resume 命令

**文件：** `src/tui/app.tsx`
**依赖：** T12、T24、T26、T26b
**步骤：**
1. 新增 state `resumeList: SessionInfo[] | null` 与 `pendingResumeRef = useRef<SessionInfo[] | null>(null)`。
2. `handleSubmit` 增加 `/resume` 分支（位于运行中拦截之后，此时运行中只剩 `/resume` 能到达）：`listSessions(workDir, sessionWriterRef.current.id)` 为空 → system 消息「暂无历史会话」并返回 `true`（运行中不中断本轮）；非空且 `isStreaming` → `pendingResumeRef.current = list`，按 Esc 同样的方式先兑付挂起确认再 `abortControllerRef.current?.abort()`；非空且空闲 → `setResumeList(list)`。
3. `runAgentLoop` 的 `finally` 末尾：`if (pendingResumeRef.current) { setResumeList(pendingResumeRef.current); pendingResumeRef.current = null; }`。本轮以 cancelled 收尾，TurnCollector 返回 null，不入队记忆更新。
4. 渲染：`resumeList` 非空时用 `SessionSelect` 替换 InputBox（互斥，避免争抢按键）。
5. `onCancel` → `setResumeList(null)`。
6. `onSelect(id)` → `handleResume(id)`：client 未就绪时报错返回；新建 `new SessionWriter(id, workDir, onError)` 赋给 `sessionWriterRef`；`await resumeSession({ workDir, id, conversation, writer, compactor })`；追加分隔行「──── 已恢复会话 <id> ────」、`display` 各条（user / assistant / system 原样映射为 ChatMessage）、汇总提示「已恢复会话 <id>：N 条消息」并附「跳过 K 行损坏记录」「末尾未完成的工具调用已截断」「已先压缩一次 / 压缩失败，后续由自动压缩接管」「已提醒模型：距上次对话已过去 X」中适用的部分；`setResumeList(null)`。

**验证：** `bun run typecheck` 零错误；`bun test` 全过。

## T28: 全量回归

**文件：** 无
**依赖：** T1–T27
**步骤：**
1. `bun test` 全量。
2. `bun run typecheck`。
3. `git status` 确认没有误改无关文件；临时测试目录均已清理。

**验证：** 全部测试通过、tsc 零错误。

## T29: 端到端验证（tmux）

**文件：** 无
**依赖：** T28
**步骤：** 按 checklist.md 的端到端场景，在 tmux 中启动 MewCode 执行；逐项记录证据并在 checklist.md 打勾。

**验证：** checklist.md 端到端场景全部通过，或未通过项写明原因与修复。

## 执行顺序

```
T1 ─┬─ T5 → T6 → T7
    ├─ T8 → T9 → T10 → T11
    │         └──────────────→ T12 → T13
    └─ T14 → T15 → T16
          └─ T17 → T18 → T19 → T20
T2 → T3          （T8 依赖 T2）
T4               （T9、T12 依赖 T4）T21（可并行）

T6 + T10 + T15 → T22 → T23 → T24 → T25
T10 → T26 ─────────────────────┐
T26b（可并行）─────────────────┤
T12 + T24 + T26 + T26b ────────→ T27 → T28 → T29
```

建议线性执行：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20 → T21 → T22 → T23 → T24 → T25 → T26 → T26b → T27 → T28 → T29。

---

# 增量：并发保护（spec F15–F17）

> T1–T29 已于 2026-10-19 完成并验收。本组任务在其基础上增量实现，不改动已验收行为。
> 临时文件名唯一化（F17 后半）现有实现已满足：`MemoryStore.atomicWrite` 的临时文件名带 6 字节随机串且以 `wx` 独占创建，无需改动。

## 增量文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/tools/limits.ts` | 新增记忆锁等待 / 残留 / 重试间隔常量 |
| 新建 | `src/memory/lock.ts` | 锁文件独占获取、存活检测、残留回收、会话锁路径 |
| 新建 | `tests/memory/lock.test.ts` | 锁原语测试 |
| 修改 | `src/memory/session.ts` | `SessionInfo.inUse`；过期清理跳过被占用会话 |
| 修改 | `src/memory/notes.ts` | `MemoryStore.lockPath`、`fingerprint()` |
| 修改 | `src/memory/updater.ts` | 写入阶段持锁、指纹比对、冲突重跑一次 |
| 修改 | `src/tui/app.tsx` | 新会话占用、`/resume` 换锁、退出释放 |
| 修改 | `src/tui/session-select.tsx` | 「使用中」标注 |
| 修改 | 仓库根 `.gitignore` | 忽略 `**/.mewcode/locks/` |
| 修改 | `tests/memory/session.test.ts`、`notes.test.ts`、`updater.test.ts` | 并发相关用例 |

## T30: 锁常量

**文件：** `src/tools/limits.ts`
**依赖：** 无
**步骤：**
1. 在记忆系统常量一节末尾追加 `MEMORY_LOCK_WAIT_MS = 2_000`（F16 等待上限）、`MEMORY_LOCK_STALE_MS = 30_000`（F16 残留判定）、`LOCK_RETRY_INTERVAL_MS = 50`（F16 重试间隔），带中文行尾注释。

**验证：** `bun run typecheck` 零错误。

## T31: 锁原语

**文件：** `src/memory/lock.ts`
**依赖：** T30
**步骤：**
1. 定义 `LockRecord { pid, ts }`、`Release = () => void`。
2. `isProcessAlive(pid)`：`process.kill(pid, 0)` 成功为 true；`ESRCH` 为 false；`EPERM` 为 true。
3. `sessionLockPath(workDir, id)` → `<workDir>/.mewcode/locks/sessions/<id>.lock`。
4. 私有 `isStale(record | null, staleMs?)`：记录为 null（缺失或解析失败）、pid 不存活、或给了 `staleMs` 且 `Date.now() − ts > staleMs`。
5. `tryAcquire(path, staleMs?)`：`mkdirSync(dirname, recursive)`；`writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" })` 成功 → 返回释放函数；`EEXIST` → 读记录，`isStale` 则 `unlinkSync` 后再 `wx` 一次（只一次），仍失败返回 null；其他错误返回 null。
6. 释放函数：读锁文件，pid 等于 `process.pid` 才删除；闭包标记保证重复调用安全；异常吞掉。
7. `acquire(path, waitMs, staleMs?)`：循环 `tryAcquire`，失败等 `LOCK_RETRY_INTERVAL_MS`，累计超过 `waitMs` 返回 null。
8. `isHeldByOther(path, staleMs?)`：文件不存在 false；pid 为本进程 false；否则 `!isStale(record, staleMs)`。

**验证：** `bun run typecheck` 零错误。

## T32: 锁原语测试

**文件：** `tests/memory/lock.test.ts`
**依赖：** T31
**步骤：** 全部在临时目录内：
1. `tryAcquire` 首次成功、锁文件含本进程 pid；手写一份 pid 为 `process.ppid` 的锁文件后 `tryAcquire` 返回 null（AC18/AC19）。
2. pid 为 999999 的锁文件 → 成功回收（AC18）。
3. pid 存活但 ts 为 60 秒前：给 `staleMs = 30_000` 时回收成功；不给 staleMs 时返回 null（AC19）。
4. 乱码锁文件 → 视为残留，回收成功。
5. 释放函数删除锁文件；重复调用不抛；锁文件被换成别的 pid 后释放不删除它。
6. `acquire`：另一持有者 150ms 后删除锁文件 → `waitMs = 1000` 内成功；持有者不释放 → `waitMs = 200` 返回 null（AC19）。
7. `isHeldByOther`：无文件 false；本进程持有 false；存活的他人 pid true；死 pid false。

**验证：** `bun test tests/memory/lock.test.ts` 全过。

## T33: 会话占用感知

**文件：** `src/memory/session.ts`、`tests/memory/session.test.ts`
**依赖：** T31
**步骤：**
1. `SessionInfo` 增加 `inUse: boolean`；`listSessions` 中 `inUse = isHeldByOther(sessionLockPath(workDir, id))`。
2. `cleanupExpiredSessions` 中超期且 `isHeldByOther(...)` 为 true 的会话跳过。
3. 测试：锁 pid 为 `process.ppid` 时 `inUse === true`，pid 为 999999 时 `false`；31 天前且被存活进程占用的会话不被清理（AC18）。

**验证：** `bun test tests/memory/session.test.ts` 全过（原有用例不变）。

## T34: 笔记目录锁路径与指纹

**文件：** `src/memory/notes.ts`、`tests/memory/notes.test.ts`
**依赖：** T30
**步骤：**
1. `MemoryStore` 增加只读 getter `lockPath`：`join(dirname(this.dir), "locks", "memory.lock")`，即用户级 `~/.mewcode/locks/memory.lock`、项目级 `<workDir>/.mewcode/locks/memory.lock`。构造参数不变，现有调用方无需改动。
2. 增加 `fingerprint()`：列出目录下全部 `*.md`（含 MEMORY.md），按文件名排序依次哈希「文件名 + 内容」，取 sha1 十六进制；目录不存在返回 `"empty"`。（实现时由 `名:mtimeMs:size` 改为内容哈希：同一毫秒内同长度改写 mtime 可能不变。）
3. 测试：无变化两次相同；新增笔记、删除笔记、只改正文不改描述三种情况指纹都变化；`lockPath` 落在 `.mewcode/locks/` 下（AC19）。

**验证：** `bun test tests/memory/notes.test.ts` 全过。

## T35: 更新器持锁与乐观冲突检测

**文件：** `src/memory/updater.ts`
**依赖：** T31、T34
**步骤：**
1. 构造函数追加可选第 4 参数 `lockWaitMs = MEMORY_LOCK_WAIT_MS`（仅供测试调小），现有调用方不变。
2. 把 `run` 内「构造 Prompt → 流式请求 → 解析」抽成私有 `requestOperations(digest, signal)`：先记下 `{ user: stores.user.fingerprint(), project: stores.project.fingerprint() }`，再沿用现有请求与校验逻辑（中止、截断、工具调用检查不变），返回 `{ operations, fingerprints } | null`。
3. `run` 改为最多两次尝试，每次：
   - `requestOperations`；为 null 或 operations 为空 → 结束；
   - 本批涉及的范围按 `["user", "project"]` 顺序逐个 `acquire(store.lockPath, lockWaitMs, MEMORY_LOCK_STALE_MS)`；任一返回 null → 逆序释放已获取的锁并结束；
   - 持锁下比对涉及范围的指纹：不一致 → 释放；首次尝试则进入第二次，否则结束；
   - 一致 → `applyOperations`，`finally` 逆序释放；变更非空且未中止时 `onUpdated(names)`。
4. 现有的 `Promise.race([update(), cancelled])` 中止机制保持不变，包住整个两次尝试。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/updater.test.ts` 原有用例全过。

## T36: 更新器并发测试

**文件：** `tests/memory/updater.test.ts`
**依赖：** T35
**步骤：**
1. 冲突重跑：假客户端第一次返回前，测试代码向项目级目录写入一条笔记（模拟另一实例）→ 第一批操作未落盘；假客户端收到第二次请求且内含新笔记的索引行；第二批正确写入（AC19）。
2. 两次都冲突：每次返回前都改目录 → 放弃，目录中只有测试代码写入的内容，`onUpdated` 未调用（AC19）。
3. 锁被占用：预先手写 pid 为 `process.ppid`、ts 为当前时间的项目级记忆锁，`lockWaitMs = 200` → 放弃，无写入、无 `.tmp` 残留（AC19）。
4. 残留锁：预先手写 pid 为 999999 的记忆锁 → 正常写入（AC19）。
5. 更新完成后记忆锁文件不存在。

**验证：** `bun test tests/memory/updater.test.ts` 全过。

## T37: TUI 会话占用

**文件：** `src/tui/app.tsx`、`src/tui/session-select.tsx`
**依赖：** T33
**步骤：**
1. app.tsx 新增 `sessionReleaseRef = useRef<Release | null>(null)`；在首次创建写入器的分支里同时 `sessionReleaseRef.current = tryAcquire(sessionLockPath(workDir, id))`（新 ID 不会被占用；null 也不影响存档）。
2. `useEffect` 注册一次 `process.on("exit", ...)` 调用 `sessionReleaseRef.current?.()`，卸载时移除监听。
3. `handleResume(id)`：在 `createWriter(id)` 之前 `const release = tryAcquire(sessionLockPath(workDir, id))`；为 null → `addNotice("该会话正在被另一个 MewCode 使用", true)` 并返回（`finally` 照常复位 activity，历史不变）；否则先 `sessionReleaseRef.current?.()` 再赋值为 `release`。`resumeSession` 抛错时释放新锁，维持旧会话的占用（旧锁已释放则重新 `tryAcquire` 旧 ID）。
4. session-select.tsx：`inUse` 的行在消息数后追加 ` · 使用中`，非光标行用 muted 色（光标行颜色不变，便于看清当前选的是谁）。

**验证：** `bun run typecheck` 零错误；`bun test tests/memory/tui.test.ts` 全过；启动后 `.mewcode/locks/sessions/<ID>.lock` 存在且含当前 pid，`/exit` 后消失。

## T38: .gitignore

**文件：** 仓库根 `.gitignore`
**依赖：** 无
**步骤：**
1. 在会话存档规则之后追加注释「跨进程锁文件（记忆系统 F17）」与 `**/.mewcode/locks/`。

**验证：** `git check-ignore -v typescript/.mewcode/locks/memory.lock` 命中；`git check-ignore typescript/.mewcode/memory/x.md` 无输出。

## T39: 回归与验收

**文件：** 无
**依赖：** T30–T38
**步骤：**
1. `bun test` 全量、`bun run typecheck`。
2. 逐项验证 checklist.md「并发保护」一节并打勾；端到端场景 6 需两个终端窗格，环境不具备时注明原因并用双进程脚本替代验证。

**验证：** 全部测试通过、tsc 零错误；checklist 并发保护一节逐项有证据。

## 增量执行顺序

```
T30 → T31 → T32
        ├─→ T33 ─→ T37
        └─→ T34 ─→ T35 → T36
T38（可并行）
全部 → T39
```

建议线性执行：T30 → T31 → T32 → T33 → T34 → T35 → T36 → T37 → T38 → T39。
