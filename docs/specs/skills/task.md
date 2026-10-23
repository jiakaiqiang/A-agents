# Skill 系统（一期）Tasks

> 依据：docs/specs/skills/spec.md、plan.md（均已批准）。命令在 `typescript/` 下执行。
> 「typecheck」指 `bun run typecheck`；「单测」指 `bun test tests/skills/`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/skills/types.ts` | SkillDef、ParseResult、SkillLoadResult、ActiveSkill、IsolatedOutcome、IsolatedRunner |
| 新建 | `src/skills/parser.ts` | parseSkill、expandBody、SKILL_NAME_PATTERN |
| 新建 | `src/skills/loader.ts` | loadSkills、builtinSkillsDir |
| 新建 | `src/skills/catalog.ts` | skillCatalogSection、pinnedSection |
| 新建 | `src/skills/manager.ts` | SkillManager、LOAD_SKILL_TOOL |
| 新建 | `src/skills/isolated.ts` | recentHistory、runIsolatedSkill、isolatedToolScope、resultMessage |
| 新建 | `src/skills/load-tool.ts` | createLoadSkillTool |
| 新建 | `src/skills/builtin/commit.md`、`review.md`、`test.md` | 三个内部样板 |
| 新建 | `src/commands/builtins/skills.ts` | skillCommand、registerSkillCommands、SKILLS_COMMAND、bootstrapSkills |
| 删除 | `src/commands/builtins/review.ts` | 由 review Skill 取代 |
| 修改 | `src/tools/limits.ts` | SKILL_FILE_MAX_BYTES、SKILL_CATALOG_DESC_MAX_CHARS |
| 修改 | `src/tools/types.ts` | Tool.system、ToolContext.allowedTools、ToolErrorKind "not_allowed" |
| 修改 | `src/tools/registry.ts` | DefinitionOptions.only |
| 修改 | `src/tools/execute.ts` | runTool 入口拦截集合外工具 |
| 修改 | `src/permission/limits.ts` | classifyTool：system → read |
| 修改 | `src/llm/client.ts`、`anthropic.ts`、`openai.ts` | StreamOptions.pinned 与钉住段落位 |
| 修改 | `src/agent/loop.ts` | SkillView、按集合过滤工具与延迟目录、传 pinned、无效迭代判定 |
| 修改 | `src/commands/types.ts`、`format.ts`、`builtins/index.ts` | CommandUI 三个方法、SkillListItem、formatSkills、去掉 /review 加 /skills |
| 修改 | `src/tui/app.tsx` | renderAgentEvent / finishTurn 抽取、skills 接入、invokeSkill、runIsolatedTurn、runner 注入 |
| 修改 | `src/main.tsx` | MCP 之后 bootstrapSkills，传入 App |
| 新建 | `tests/skills/parser.test.ts`、`loader.test.ts`、`catalog.test.ts`、`manager.test.ts`、`isolated.test.ts`、`load-tool.test.ts`、`integration.test.ts`、`commands.test.ts` | 单测与集成测试 |
| 新建 | `tests/skills/fixtures/tui.tsx`、`tests/skills/tui.test.ts` | 真实 Ink 子进程测试 |
| 修改 | `tests/commands/builtins.test.ts`、`fake-ui.ts`、`fixtures/tui.tsx`、`tests/permission/limits.test.ts`、`tests/tools/registry.test.ts`、`tests/llm/messages.test.ts` | 适配改动、补用例 |

> 与 plan 的出入：新增 `bootstrapSkills()`（放在 `commands/builtins/skills.ts`），把 main.tsx 里「loadSkills → registerSkillCommands → new SkillManager → 注册 loadSkill → 生成摘要」这串步骤收成一个函数。原因同斜杠命令的 `createCommandsOrExit`：main.tsx 有顶层副作用不能 import，抽出后 Ink fixture 能走和 main 完全相同的装配代码。依赖方向仍是 commands → skills。

---

## T1: 类型与常量

**文件：** `src/skills/types.ts`、`src/tools/limits.ts`
**依赖：** 无
**步骤：**
1. 按 plan「核心数据结构」写出 `SkillSource`、`SkillMode`、`SkillDef`、`ParseResult`、`SkillLoadResult`、`ActiveSkill`、`IsolatedOutcome`、`IsolatedRunner`（`ToolContext` 从 `tools/types.ts` 引类型）。
2. `limits.ts` 加 `SKILL_FILE_MAX_BYTES = 64 * 1024`、`SKILL_CATALOG_DESC_MAX_CHARS = 80`，各带一行注释指向 spec N5、N1。

**验证：** typecheck 零错误。

## T2: frontmatter 解析

**文件：** `src/skills/parser.ts`、`tests/skills/parser.test.ts`
**依赖：** T1
**步骤：**
1. 导出 `SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/`。
2. `parseSkill(text, { dirName, source, path })`：去 BOM、统一换行为 `\n`；用 `^---\n([\s\S]*?)\n---\n?` 切出 frontmatter，切不出 → `{ ok:false, reason:"缺少 frontmatter" }`。
3. js-yaml `load` 包 try/catch，失败 → `reason: "frontmatter 不是合法 YAML：…"`；结果不是对象 → 同样失败。
4. 按 spec F1 逐字段校验，失败原因写明字段名：name 缺失/不匹配模式/≠ dirName；description 缺失/空/含换行；tools 不是字符串数组；mode 非 shared|isolated；history 非非负整数；model 非非空字符串；正文 trim 为空。
5. 告警：已知字段集 `{name, description, tools, mode, history, model}` 之外的键 → 「未知字段 x，已忽略」；mode 为 shared 时出现 history 或 model → 「共享模式忽略 history/model」，结果里 history 置 0、model 不设。
6. 测试：AC1 的六种失败各一例（断言 ok:false 且 reason 含关键字）；未知字段、共享模式写 model 各一例（ok:true 且 warnings 有对应条目）；完整合法 isolated Skill 一例（字段全部正确映射）；CRLF 与 BOM 文件可解析。

**验证：** `bun test tests/skills/parser.test.ts` 全绿；typecheck 零错误。

## T3: 参数替换

**文件：** `src/skills/parser.ts`、`tests/skills/parser.test.ts`
**依赖：** T2
**步骤：**
1. `expandBody(body, args)`：`args` 先 trim；正文含 `$ARGUMENTS` → `replaceAll`（用函数形式替换，避免 args 里的 `$&` 被当成特殊模式）；不含且 args 非空 → `${body.trimEnd()}\n\n${args}`；否则原样返回。
2. 测试（AC2）：两处占位符都被替换；无参替换为空串；无占位符有参追加到末尾、中间空一行；args 含 `$&` 原样保留。

**验证：** `bun test tests/skills/parser.test.ts` 全绿。

## T4: 三级发现与覆盖

**文件：** `src/skills/loader.ts`、`tests/skills/loader.test.ts`
**依赖：** T2
**步骤：**
1. `builtinSkillsDir()` 用 `fileURLToPath(new URL("./builtin", import.meta.url))`。
2. 内部函数 `scanDir(dir, source)`：目录不存在返回空；`readdirSync(withFileTypes)` 只看第一层：`<名字>.md` 文件、`<名字>/SKILL.md`；同名两种并存 → 用目录型并告警「x.md 与 x/SKILL.md 并存，使用目录型」；其余条目静默忽略。每个候选读取后调 `parseSkill`（dirName 为去掉 `.md` 的文件名或目录名），失败 → 告警「<path>：<reason>」并跳过；成功的 warnings 加路径前缀并入总告警。单个候选整段 try/catch（N4）。
3. `loadSkills({ workDir, homeDir, availableTools, builtinDir })`：按 内部 → `~/.mewcode/skills` → `<workDir>/.mewcode/skills` 顺序扫描，写入同一个 `Map<name, SkillDef>`，后写覆盖先写。本任务先不做白名单校验与安全读取（T5）。
4. 结果按名字排序，`counts` 按最终 Map 里的 source 统计。
5. 测试（用临时目录，builtinDir 注入）：AC3 三层同名生效项目级、删项目级后生效用户级；同层并存用目录型且有告警；`x/` 下的 `notes.md` 不被当作 Skill；AC4 一个损坏一个正常，正常的可用、损坏的有告警；skills 目录不存在时无告警。

**验证：** `bun test tests/skills/loader.test.ts` 全绿。

## T5: 安全读取与白名单校验

**文件：** `src/skills/loader.ts`、`tests/skills/loader.test.ts`
**依赖：** T4、T1
**步骤：**
1. 读取前：`realpathSync(候选)` 必须以 `realpathSync(skills 目录) + sep` 开头，否则告警「指向 skills 目录之外，已跳过」；`statSync().size > SKILL_FILE_MAX_BYTES` 告警「超过 64KB，已跳过」。
2. 覆盖完成后对 Map 里每个 Skill：`tools` 中不在 `availableTools` 的名字收集起来，非空 → 删除该 Skill，告警「<path>：白名单包含不存在的工具 A、B，本次未加载」。
3. 测试：AC5 白名单含不存在工具被跳过且告警含路径与工具名；availableTools 含 `mcp_x` 时白名单写 `mcp_x` 正常加载；AC18 指向目录外的符号链接被跳过（创建符号链接失败时 `test.skipIf`，Windows 无权限场景）；65KB 文件被跳过并告警。

**验证：** `bun test tests/skills/loader.test.ts` 全绿。

## T6: 三个内部样板

**文件：** `src/skills/builtin/commit.md`、`review.md`、`test.md`、`tests/skills/loader.test.ts`
**依赖：** T4
**步骤：**
1. `commit.md`：mode shared，tools `[Bash, Read, Glob, Grep]`；正文：先 `git status`、`git diff`（含 staged），按 `type(scope): 描述` 约定写提交说明，`提交说明关注点：$ARGUMENTS`；提交前把说明给用户确认。
2. `review.md`：mode shared，同白名单；正文保留原 `/review` 模板的要点（用 git diff 查看未提交改动，指出缺陷、风险、改进建议），`审查范围：$ARGUMENTS`。
3. `test.md`：mode isolated，history 0，同白名单；正文：识别项目测试命令（package.json、Makefile 等），运行，汇总失败用例与原因，最后一条回复写结论，`测试范围：$ARGUMENTS`。
4. 测试（AC16 前半）：用真实 `builtinSkillsDir()` 加载，三个都成功、无告警，mode 与 tools 符合定义。

**验证：** `bun test tests/skills/loader.test.ts` 全绿。

## T7: 目录与钉住文本

**文件：** `src/skills/catalog.ts`、`tests/skills/catalog.test.ts`
**依赖：** T1
**步骤：**
1. `skillCatalogSection(skills)`：空数组返回 `""`；否则按 plan 的格式输出标题、用法提示（`loadSkill({"name": …, "args": …})` 与 `/<名字>`）、每个 Skill 一行；isolated 的行尾加「（独立运行）」；说明超过 `SKILL_CATALOG_DESC_MAX_CHARS` 截断到 79 字加「…」。
2. `pinnedSection(active)`：空返回 `""`；否则 `<active-skills>` 包裹，每段 `## Skill: <名字>` + expanded。
3. 测试：AC7 目录只含名字与说明、不含任何正文片段；超长说明被截断；空列表返回空串；钉住文本按传入顺序排列。

**验证：** `bun test tests/skills/catalog.test.ts` 全绿。

## T8: SkillManager

**文件：** `src/skills/manager.ts`、`tests/skills/manager.test.ts`
**依赖：** T3、T7
**步骤：**
1. `LOAD_SKILL_TOOL = "loadSkill"`；内部 `Map<string, SkillDef>` 存全部，`Map<string, ActiveSkill>` 存激活（Map 的插入顺序即激活顺序，`set` 已存在的键原位替换）。
2. `activate(name, args)`：不存在或非 shared → 抛错；`expanded = expandBody(body, args)`。
3. `deactivate(name?)`：不传清空全部并返回原名单；传名字只删该项，未激活返回 `[]`。
4. `pinnedText()` = `pinnedSection([...active.values()])`。
5. `allowedTools()`：无激活 → null；任一 `tools === null` → null；否则所有 tools 的并集 + `LOAD_SKILL_TOOL`。
6. `setIsolatedRunner`、`runIsolated(name, args, context)`：Skill 不存在或非 isolated → 抛错；没注入 runner → `{ ok:false, text:"独立模式运行器未就绪" }`。
7. 测试：再次激活原位替换且顺序不变（AC9 单元部分）；激活 A、B 顺序为 A、B；deactivate 单个与全部；allowedTools 并集、含无白名单项时为 null、无激活为 null（AC11 单元部分）；runIsolated 没 runner 时 ok:false。

**验证：** `bun test tests/skills/manager.test.ts` 全绿。

## T9: 工具层：system、集合过滤与拦截

**文件：** `src/tools/types.ts`、`src/tools/registry.ts`、`src/tools/execute.ts`、`tests/tools/registry.test.ts`、`tests/skills/integration.test.ts`
**依赖：** 无
**步骤：**
1. `types.ts`：`Tool` 加 `readonly system?: boolean`；`ToolContext` 加 `allowedTools?: ReadonlySet<string>`；`ToolErrorKind` 加 `"not_allowed"`（注释：工具不在当前 Skill 白名单内）。
2. `registry.ts`：`DefinitionOptions.only` 存在时，在 readOnlyOnly 筛选之后再按名字过滤。
3. `execute.ts`：`runTool` 第一行判断 `context.allowedTools && !context.allowedTools.has(name)` → `fail("not_allowed", \`工具 ${name} 不在当前可用工具中\`)`，位于懒池补载之前。
4. 测试：`definitionsFor(protocol, { only })` 只返回集合内工具；`runTool` 对集合外工具返回 not_allowed 且工具 execute 未被调用（用一个计数工具）；集合外的延迟工具不会被补载（`lazyNames` 不变）。

**验证：** `bun test tests/tools/ tests/skills/integration.test.ts` 全绿；typecheck 零错误。

## T10: 权限分类

**文件：** `src/permission/limits.ts`、`tests/permission/limits.test.ts`
**依赖：** T9
**步骤：**
1. `classifyTool`：首行 `if (tool.system) return "read";`。
2. 测试：`system: true, readOnly: false` 的工具在四个档位下兜底都是 allow。

**验证：** `bun test tests/permission/` 全绿。

## T11: LLM 适配器钉住段

**文件：** `src/llm/client.ts`、`src/llm/anthropic.ts`、`src/llm/openai.ts`、`tests/llm/messages.test.ts`
**依赖：** 无
**步骤：**
1. `StreamOptions` 加 `pinned?: string`（注释：已激活 Skill 指令，位于系统提示词之后、历史之前，每次请求都带）。
2. `buildSystemBlocks(segments, pinned?)`：pinned trim 非空时追加第三个 `{ type:"text", text: pinned }`，不带 cache_control；`stream` 里传 `options.pinned`。
3. openai.ts：抽一个 `systemContent(pinned?)` 方法，返回 `pinned?.trim() ? \`${this.systemPrompt}\n\n${pinned}\` : this.systemPrompt`，两个 client 的 system 消息都改用它。
4. 测试：无 pinned 时 `buildSystemBlocks` 仍是 2 块且与改动前相同；有 pinned 时 3 块、前两块文本与缓存标记不变、第三块无 cache_control（AC9 稳定段字节相同的单元部分）。

**验证：** `bun test tests/llm/` 全绿；typecheck 零错误。

## T12: Agent 循环接入

**文件：** `src/agent/loop.ts`、`tests/skills/integration.test.ts`
**依赖：** T8、T9、T11
**步骤：**
1. 导出 `SkillView` 接口；`LoopOptions` 加 `skills?: SkillView`。
2. 每次迭代开头：`const allowed = options.skills?.allowedTools() ?? null;`、`const pinned = options.skills?.pinnedText() || undefined;`。
3. `tools = registry.definitionsFor(protocol, allowed ? { only: allowed } : undefined)`。
4. 延迟目录：allowed 存在时只保留 allowed 内的懒条目；allowed 存在且不含 `toolSearch` 时不注入目录。
5. `collectStream(..., { signal, reminders, pinned })`；`runBatches` 的 context 加 `allowedTools: allowed ?? undefined`。
6. 无效迭代：`allUnknown` 改为每个调用满足「`!registry.get(name)` 或 `allowed && !allowed.has(name)`」。
7. 集成测试（脚本化假客户端，记录每次请求的 tools 名字与 options.pinned，沿用 `tests/agent/loop.test.ts` 的写法）：
   - 不传 skills：工具列表与 pinned 和现在一致（AC19 循环部分）。
   - 激活 [Bash, Read] 与 [Read, Grep] → 请求工具恰为 Bash、Read、Grep、loadSkill；再激活无白名单 Skill → 全部工具（AC11）。
   - 模型调用集合外的 Write → 结果为 not_allowed、文件未写（AC11）。
   - 白名单含 / 不含 toolSearch 时延迟目录出现 / 不出现，出现时只列白名单内的延迟工具（AC12）。
   - 模型连续只调集合外工具 → 按 MAX_INVALID_ITERATIONS 以 invalid_tools 中止（F10）。
   - 激活 A、B 后两次迭代的 pinned 都含 A、B 且 A 在前（AC9）。
   - 压缩后 pinned 仍在：注入一个小窗口 Compactor 触发压缩，下一次请求 pinned 不变（AC9）。
   - 白名单内 Bash 在 default 档下 confirm 回调被调用（AC11、N6）。

**验证：** `bun test tests/skills/integration.test.ts tests/agent/` 全绿；typecheck 零错误。

## T13: 截取最近历史

**文件：** `src/skills/isolated.ts`、`tests/skills/isolated.test.ts`
**依赖：** T1
**步骤：**
1. `recentHistory(messages, n)`：n ≤ 0 返回 `[]`；先去掉 system 消息，取末尾 n 条；末尾是带 toolUses 的 assistant 时丢掉它（结果未回来）；起点向后推进，直到第一条是不带 toolResults 的 user 消息，推不出就返回 `[]`；返回深拷贝。
2. 测试：n=2 刚好切在工具结果上 → 少取到配对完整；末尾悬空 tool_use 被丢掉；n 大于总数返回全部可用消息；n=0 返回空。

**验证：** `bun test tests/skills/isolated.test.ts` 全绿。

## T14: 独立子对话执行

**文件：** `src/skills/isolated.ts`、`tests/skills/isolated.test.ts`
**依赖：** T12、T13
**步骤：**
1. `isolatedToolScope(skill, registry)`：`skill.tools` 存在 → 其集合；否则 `registry.list()` 名字 + `lazyNames()`；两者都删掉 `LOAD_SKILL_TOOL`。
2. `runIsolatedSkill(options)`：`new ConversationManager()`（不挂记录器）→ `restore(recentHistory(history, skill.history))` → `addUserMessage(expandBody(body, args))`；固定 SkillView `{ pinnedText: () => "", allowedTools: () => scope }`；调 `runLoop`（不传 compactor、reminders）；`done` 之外的事件原样 yield；按 plan 规则 return outcome；整段 try/catch，异常 → `ok:false`。
3. `resultMessage(name, outcome)`：成功 `【Skill ${name} 结果】\n${text}`；失败 `【Skill ${name} 未完成】${text}`。
4. 测试（假客户端记录请求）（AC13 单元部分）：history:2 时子对话请求含最近 2 条与 SOP；请求工具里没有 loadSkill；白名单为 null 时也没有 loadSkill；成功时 outcome 为最后一条回复；signal 中断 → ok:false；客户端抛错 → ok:false。

**验证：** `bun test tests/skills/isolated.test.ts` 全绿；typecheck 零错误。

## T15: loadSkill 工具

**文件：** `src/skills/load-tool.ts`、`tests/skills/load-tool.test.ts`
**依赖：** T8、T14
**步骤：**
1. 参数 schema：`name`（必填）、`args`（可选），`readOnly: false`、`system: true`，`callSummary` 为 `loadSkill(<名字>)`。
2. execute：名字不存在 → `fail("not_found", 列出全部可用名)`；shared → activate，返回已激活与当前可用工具（allowedTools 为 null 时写「全部工具」）；isolated → `await manager.runIsolated(...)`，ok 返回 `ok(resultMessage)`，否则 `fail("exec_failed", resultMessage)`；任何异常转 `fail("exec_failed", …)`（N4）。
3. 测试（AC8）：加载 shared 后结果含「已激活」且 manager.pinnedText 含 SOP；加载 isolated 时调用注入的假 runner 并返回其摘要；不存在名字的结果列出可用 Skill；激活带白名单 Skill 后 `allowedTools()` 含 loadSkill。

**验证：** `bun test tests/skills/load-tool.test.ts` 全绿。

## T16: 命令接口与格式化

**文件：** `src/commands/types.ts`、`src/commands/format.ts`、`tests/commands/fake-ui.ts`、`tests/commands/format.test.ts`
**依赖：** T1
**步骤：**
1. `types.ts`：新增 `SkillListItem`；CommandUI 加 `listSkills()`、`deactivateSkills(name?)`、`invokeSkill(name, args, display): boolean`。
2. `format.ts`：`formatSkills(items)`：空列表「暂无可用 Skill」；否则每行 `名字  说明  模式  来源`，已激活的行尾「● 已激活」；来源显示 内部/用户/项目。
3. fake-ui 补三个方法：记录调用，`listSkills` 返回可注入的数组，`invokeSkill` 返回 true。
4. 测试：formatSkills 的空列表与激活标记。

**验证：** `bun test tests/commands/` 全绿；typecheck 零错误。

## T17: Skill 斜杠命令与 /skills

**文件：** `src/commands/builtins/skills.ts`、`src/commands/builtins/index.ts`、删除 `src/commands/builtins/review.ts`、`tests/skills/commands.test.ts`、`tests/commands/builtins.test.ts`、`tests/commands/dispatcher.test.ts`
**依赖：** T8、T15、T16
**步骤：**
1. `skillCommand(skill)`：kind "ui"、aliases []、description `${skill.description}（Skill）`、usage `/${name} [参数]`、argHint "[参数]"、availableWhileBusy false、run 调 `ui.invokeSkill(name, args, display)`（display 为 `/${name}` 加有参数时的 ` ${args}`），返回 false 时 showMessage「LLM 客户端尚未就绪」。
2. `registerSkillCommands(registry, skills)`：逐个 `registry.resolve(name)` 判冲突，冲突 → 告警「<path>：与内置命令 /x 重名，已跳过」；否则 register；返回 accepted 与 warnings。
3. `SKILLS_COMMAND`：kind "ui"、availableWhileBusy true、argHint "[off [名字]]"；无参 → `showMessage(formatSkills(ui.listSkills()))`；`off` → 停用全部，显示停用名单或「当前没有已激活的 Skill」；`off x` → 停用 x，x 不存在或未激活给提示；其他参数 → 显示用法。
4. `bootstrapSkills({ registry, commands, workDir, homeDir })`：availableTools = registry 名字 + lazyNames + loadSkill → loadSkills → registerSkillCommands → `new SkillManager(accepted)` → `registry.register(createLoadSkillTool(manager))` → 返回 `{ manager, warnings, summary }`，summary 按 accepted 计数「已加载 Skill N 个（内部 a、用户 b、项目 c）」。
5. `index.ts`：去掉 REVIEW_COMMAND 的 import 与登记，加入 SKILLS_COMMAND；删除 `review.ts`。
6. 改测试：`builtins.test.ts` 命令名列表去掉 review、加 skills，删掉 /review 两条用例（行为改由 skills 测试覆盖）；`dispatcher.test.ts` 里自带的 review 提示词定义不依赖 review.ts，保持不动。
7. 新测试（AC6、AC15 单元部分）：Skill 出现在 `/help` 和 `suggest("/co")` 里且描述带「（Skill）」；名为 `clear`、`h` 的 Skill 被跳过并告警；busy 时输入 `/commit` 被 rejected；`/skills` 列表与 `/skills off commit`、`/skills off`；bootstrapSkills 的 summary 计数正确、registry 里有 loadSkill。

**验证：** `bun test tests/commands/ tests/skills/` 全绿；typecheck 零错误。

## T18: App 重构：抽出 renderAgentEvent 与 finishTurn

**文件：** `src/tui/app.tsx`
**依赖：** 无
**步骤：**
1. 把 `runAgentLoop` 里事件 switch 的各分支搬进 `renderAgentEvent(event, prefix = "")`，`done` 分支仍留在调用方；`tool_start` 内容与 `notice` 文本加 prefix；新增参数 `updateUsage = true`，为 false 时 `usage` 事件不更新状态栏。
2. 把 `runAgentLoop` 的 finally 主体搬进 `finishTurn()`。
3. 纯重构，不改行为。

**验证：** typecheck 零错误；`bun test tests/memory/tui.test.ts tests/commands/tui.test.ts` 全绿。

## T19: App 接入 Skill 目录与循环

**文件：** `src/tui/app.tsx`
**依赖：** T12、T17、T18
**步骤：**
1. 新 props：`skills?: SkillManager`（缺省 `useRef(new SkillManager([]))` 兜底）、`skillReport?: { warnings: string[]; summary: string }`。
2. 启动告警 effect：Skill 告警以 `Skill：<text>` 红色输出，summary 普通色输出（summary 为空串不输出）。
3. 构建系统提示词时传 `skills: skillCatalogSection(manager.list())`；结果存入 `segmentsRef`。
4. `runLoop` 调用加 `skills: manager`。

**验证：** typecheck 零错误；`bun test tests/memory/tui.test.ts tests/commands/tui.test.ts` 全绿（不传 skills 时行为不变）。

## T20: App 共享模式调用与停用

**文件：** `src/tui/app.tsx`
**依赖：** T19
**步骤：**
1. commandUI 加 `listSkills`（manager.list 映射成 SkillListItem，active 来自 isActive）、`deactivateSkills`（转发 manager.deactivate）。
2. `invokeSkill(name, args, display)`：Skill 不存在 → showMessage 错误返回 true；shared → `manager.activate(name, args)` 后 `return startAgentTurn(display, args ? \`执行 Skill ${name}，参数：${args}\` : \`执行 Skill ${name}\`)`；isolated → 调 T21 的 `runIsolatedTurn`（本任务先返回 false 占位，T21 替换）。
3. `clearConversation` 与 `handleResume` 成功分支里调用 `manager.deactivate()`。

**验证：** typecheck 零错误；`bun test tests/memory/tui.test.ts tests/commands/tui.test.ts` 全绿。

## T21: App 独立模式

**文件：** `src/tui/app.tsx`
**依赖：** T14、T20
**步骤：**
1. `isolatedClient(skill)`：有 model → `createClient({ ...selectedProvider, model: skill.model }, segmentsRef.current)`；否则 `clientRef.current`。
2. `runIsolatedTurn(skill, args, display): boolean`：客户端未就绪返回 false；对话区追加用户行 display、记入输入历史、`activity = "agent"`、新建 AbortController、`setIsStreaming(true)`；异步体：取 `conversation.getMessages()` 快照 → `for await` runIsolatedSkill，事件交 `renderAgentEvent(event, \`[${name}] \`, false)` → `addUserMessage(display, display)`、`addAssistantMessage(resultMessage(...))` → 结果以 assistant 消息显示 → finally `finishTurn()`；异常 setError。
3. 在 client 就绪 effect 里 `manager.setIsolatedRunner(async (skill, args, context) => { … })`：同样取快照、选 client、`for await` 渲染事件（signal 用 `context.signal`，permission 用 `context.permission`），返回 outcome；不追加主历史（结果由 loadSkill 回灌）。
4. invokeSkill 的 isolated 分支改为 `return runIsolatedTurn(...)`。

**验证：** typecheck 零错误；`bun test tests/memory/tui.test.ts tests/commands/tui.test.ts` 全绿。

## T22: main.tsx 接线

**文件：** `src/main.tsx`
**依赖：** T17、T19
**步骤：**
1. MCP `connectAll` 之后、render 之前调用 `bootstrapSkills({ registry, commands, workDir: process.cwd(), homeDir: homedir() })`，整体 try/catch：异常时 `skills` 用空 manager、warnings 只放一条「Skill 加载失败：…」（N4）。
2. App 传入 `skills` 与 `skillReport`。

**验证：** typecheck 零错误；`bun test tests/skills/commands.test.ts` 全绿。

## T23: 适配斜杠命令 Ink fixture

**文件：** `tests/commands/fixtures/tui.tsx`
**依赖：** T17、T21
**步骤：**
1. 去掉 `REVIEW_COMMAND` 的 import，改用 `bootstrapSkills` 装配（workDir 用 fixture 临时目录，homeDir 用 fixture 的 homeDir），把 manager、skillReport 传给 App。
2. `/review src/tui` 段的断言改为：对话区显示原命令；请求 system 内容含 git diff 指令与「审查范围：src/tui」（钉住段）；最后一条用户消息是「执行 Skill review，参数：src/tui」；请求体不含 `"display"`；恢复后显示原命令（AC10、AC16 后半）。
3. 运行中拒绝列表里的 `/review` 保持（Skill 命令运行中不可用）。

**验证：** `bun test tests/commands/tui.test.ts` 全绿。

## T24: Skill 系统 Ink 测试

**文件：** `tests/skills/fixtures/tui.tsx`、`tests/skills/tui.test.ts`
**依赖：** T22、T23
**步骤：**
1. fixture 结构沿用 `tests/commands/fixtures/tui.tsx`（本地 openai-compat SSE 服务 + PassThrough stdin/stdout + 子进程运行）。临时 workDir 下放：`.mewcode/skills/commit.md`（覆盖内部 commit，正文带唯一标记）、`.mewcode/skills/clear.md`（与内置命令重名）、`.mewcode/skills/broken.md`（坏 YAML）、`.mewcode/skills/deploy.md`（白名单含 `Deploy`）、`.mewcode/skills/iso.md`（isolated、history 2、model `iso-model`、tools [Read]）。
2. 断言：
   - 启动：输出含 clear、broken、deploy 三条告警（含路径与原因）与加载摘要，计数与实际一致（AC17、AC1、AC5、AC6）。
   - 首个请求 system 含目录（commit、iso、review、test 各一行），不含任何 SOP 唯一标记（AC7）。
   - `/commit 修复登录超时`：对话区显示原命令；请求 system 含项目级 commit 的唯一标记（覆盖生效，AC3）与替换后的参数；用户消息为触发语；工具列表恰为白名单 + loadSkill（AC10、AC11）。
   - `/skills`：列表含「● 已激活」；`/skills off commit` 后下一次请求 system 不含 commit 标记、工具列表恢复全部（AC15）。
   - `/iso 范围X`：请求 `model` 为 `iso-model`、工具只有 Read、消息含主历史最近 2 条与 SOP；对话区出现 `[iso]` 前缀工具行（服务端让子对话调一次 Read）；结束后主历史末尾两条为原命令与「【Skill iso 结果】」开头的回复（AC13、AC14）。
   - 再跑一次 `/iso`，服务端挂起子对话，按 Esc → 出现「本轮已中断」，主历史末尾为「【Skill iso 未完成】」，随后普通消息可正常对话；会话存档 jsonl 中不含子对话的 SOP 唯一标记（AC14）。
   - 激活 commit 后 `/clear`，下一次请求 system 不含钉住段；再激活后 `/resume` 选回旧会话，下一次请求同样不含（AC15）。
3. 结束输出 `TUI_SKILLS_OK`；`tui.test.ts` 起子进程断言退出码 0 与该标记。
4. 变异检验：分别临时去掉 `runTool` 的集合拦截、`pinned` 传参、子对话的 `setRecorder` 隔离（改为共用主 conversation），确认 fixture 在对应断言处失败后还原。

**验证：** `bun test tests/skills/tui.test.ts` 全绿；三次变异均在预期断言处失败。

## T25: 全量回归

**文件：** 无
**依赖：** T1–T24
**步骤：**
1. `bun run typecheck`。
2. `bun test`，与开发前基线（454）对比，确认原有用例全部通过（被删除的两条 /review 用例除外，计数变化在报告里说明）。
3. 确认 `src/skills/` 下无 `ink`、`react`、`../tui`、`../commands` 导入，`src/agent/` 下无 `../skills` 导入（Grep）。

**验证：** typecheck 零错误；`bun test` 0 fail；Grep 无匹配。

## T26: 端到端手工验收

**文件：** `docs/specs/skills/checklist.md`（勾选与记录）
**依赖：** T25
**步骤：**
1. 本机无 tmux（Windows 与 WSL 均已确认），给出逐项操作脚本，由用户在真实终端 `bun run start` 用真实 provider 走 checklist 的端到端场景。
2. 根据回报勾选；不通过的先定位修复再请用户复验。

**验证：** checklist 端到端场景全部勾选，附用户回报。

---

## 执行顺序

```
T1 → T2 → T3 ─────────┐
      └→ T4 → T5      │
           └→ T6      │
T1 → T7 ──────────────┼→ T8 ─┐
T9 → T10              │      │
T11 ──────────────────┴──────┴→ T12 → T13 → T14 → T15
T1 → T16 ─────────────────────────────────────────┴→ T17
T18 ──────────────────────────────────────────────────┴→ T19 → T20 → T21 → T22 → T23 → T24 → T25 → T26
```

可并行：T2–T7、T9–T11、T16、T18 彼此独立。
