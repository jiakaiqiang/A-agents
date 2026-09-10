# 权限系统 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为，不逐行读代码。
> 命令统一在 `typescript/` 目录下执行。
>
> **验收执行记录（2026-09-10）**：`bun run typecheck` 无错误，`bun test` 209 pass / 0 fail（24 个文件，586 次断言）。
> tmux 在本机（Windows 11 家庭版）不可用，原计划的 8 个 tmux 场景改为 `tests/permission/integration.test.ts`
> 的 11 个集成用例覆盖——走完整的 `runTool → decide` 链，用桩 confirm 模拟用户按键。
> 涉及真实终端渲染与键盘交互的条目无法自动验证，已在对应项标注。

## 统一判定

- [x] 权限判定在工具执行前发生，拒绝时工具未产生任何副作用（证据：集成用例「拒绝时工具没有产生副作用」——选拒绝后 `never.txt` 不存在；AC1）
- [x] 判定结果只有放行与拒绝两种，没有中间态泄漏到工具层（证据：`PermissionDecision` 是二元判别联合，`decide.test.ts` 全部断言只取这两值；AC1）
- [x] 黑名单命中时规则层不被求值（证据：`decide.test.ts`「黑名单短路，规则层不被求值」——规则层 getter 抛异常仍正常返回拒绝；AC2）
- [x] 权限拒绝以工具失败结果回给模型，Agent Loop 继续运行（证据：集成用例「场景 2」——拒绝后同一上下文的 Glob 调用仍成功；AC3）
- [x] 循环终止原因集合未新增取值（证据：`StopReason` 仍为五种，`loop.test.ts` 全绿；AC3）
- [x] 拒绝时工具的 `execute` 未被调用（证据：`execute.ts:41` 在 `try` 块之前 return，集成用例验证文件未生成；AC1、N1）

## 第一层：黑名单

- [x] 黑名单列举的高危命令被拒绝（证据：`blacklist.test.ts` 7 个用例全绿，含 `rm -rf /`、`curl | sh`；AC4）
- [x] 多空格变体不能绕过（证据：同上「多空格变体同样被拒」；AC4）
- [x] 放行档 + 匹配的 allow 规则下，黑名单命令仍被拒绝（证据：`decide.test.ts` 首个用例，`layer === "blacklist"`；AC5）
- [x] 非 Bash 工具不被黑名单干预（证据：`blacklist.test.ts`「非 Bash 工具不表态」；AC4）
- [x] 项目内的正常删除不被误伤（证据：`blacklist.test.ts`「项目内删除不误伤」——`rm -rf dist` 不表态；AC4）

## 第二层：路径沙箱

- [x] 工作目录外的绝对路径被拒（证据：`sandbox.test.ts`「Write 目录外绝对路径被拒」；AC6）
- [x] 通过 `..` 逃逸的相对路径被拒（证据：同上「Bash .. 越界被拒」；AC6）
- [x] 指向目录外的符号链接被拒（证据：同上「指向目录外的符号链接被拒」；AC6）
- [x] 工作目录内尚不存在的新文件写入被放行（证据：同上「Write 目录内尚不存在的新文件不表态」；AC6）
- [x] 命令 `cat /etc/passwd` 与 `cd ../other && ls` 被拒，`npm test` 被放行（证据：同上三个用例；AC7）
- [x] 引号包裹的路径能被识别（证据：同上「抓取引号内的路径」；F7）
- [x] 选项词不被误判为路径（证据：同上「选项词不当路径」；F7）
- [x] 放行档下工作目录外的文件写入仍被拒（证据：`decide.test.ts`「沙箱在放行档仍拒目录外写入」+ 集成用例「场景 4」，目标文件确认未生成；AC8）

## 第三层：规则引擎

- [ ] `Bash(git *)` 放行 `git status`（验证：`bun test tests/permission/rules.test.ts`；AC9）
- [x] 精确规则只命中完全一致的调用（证据：`rules.test.ts`「精确匹配不泛化」；AC9）
- [x] 命令串联被整串放行，与已知取舍一致（证据：同上「命令串联整串匹配」；AC10）
- [x] 跨层优先级为会话 > 本地 > 项目 > 用户（证据：同上「跨层：本地盖过项目，本地盖过用户」；AC11）
- [x] 同层内书写靠后的规则生效（证据：同上「同层靠后的赢」——两行顺序调换后结论反转；AC12）
- [x] 规则格式解析容错（证据：同上「模式内括号取末个右括号」「缺括号返回 undefined」；F9）

## 第四层：权限档位

- [x] 四档 × 三类工具的兜底矩阵与 spec 表格一致（证据：`decide.test.ts`「四档三类工具的兜底矩阵」逐格断言 12 种组合；AC13）
- [x] deny 规则不被放行档覆盖（证据：同上用例 + 集成用例「场景 6」；AC14）
- [x] allow 规则不被计划档变成需确认（证据：同上用例断言 `asked === 0` 且 `layer === "rule"`；AC14）
- [x] 四个切换命令生效于后续调用（证据：`app.tsx` 四个命令分支各自调 `switchMode`，档位同时写入 state 与 ref；Gate 每轮重建从 ref 读档位。运行时行为需真实终端观察；AC15）
- [~] 切换后不影响正在执行中的调用（代码保证：确认框与输入框互斥渲染，弹出期间无法提交命令。需真实终端观察；F16）
- [x] 配置未声明档位时以默认档启动（证据：`config.test.ts`「未声明档位时为默认档」；AC16）
- [x] 档位值非法时退默认档并提示（证据：同上「非法档位退默认并警告」——`strict` 退默认且有 warning；AC16）
- [x] 计划档提示词含计划模式提醒，默认档不含（证据：`bun test tests/prompt/` 全绿，`ModeTracker` 仅在 plan 下注入；AC17）
- [x] 计划档下下发给模型的工具列表包含写类工具与 Bash（证据：`loop.test.ts`「计划模式同样下发全部工具定义」断言六个工具名；AC18）
- [x] 提示词不再声称计划模式只有只读工具可用（证据：`sections.ts:60` 与 `reminder.ts` 的 `PLAN_FULL` 已改写为「工具可用但每次确认」；AC18、N7）

## 第五层：人在回路

- [x] 未命中规则的写类调用在默认档下触发确认，请求含调用摘要与四个选项（证据：集成用例「场景 1」`asked` 收到 `Write(note.txt)`；`ConfirmBox` 的 `OPTIONS` 为四项；AC19）
- [x] 「本次放行」执行该调用，同一调用再次出现时再次询问（证据：集成用例「本次放行下次仍询问」——两次调用两次询问；AC20）
- [x] 「本会话放行」后同一调用不再询问，且配置文件未被写入（证据：集成用例「本会话放行不落盘」——两次调用只问一次，`config.local.yaml` 不存在；AC21）
- [x] 「本会话放行」重启后失效（证据：同上用例重建 Gate 后再次询问，等价于重启进程；AC21）
- [x] 「永久放行」写入项目本地配置且内容为精确整串（证据：集成用例「场景 5」——文件含 `Bash(echo hi)`；AC22）
- [x] 「永久放行」重启后仍生效（证据：同上用例重建 Gate 后 `asked` 为空、调用直接成功；AC22）
- [x] 「拒绝」时模型收到固定文案，界面不出现填理由的环节（证据：`decide.test.ts`「拒绝使用固定文案」断言 `reason === "用户拒绝了此操作"`；`ConfirmBox` 无输入框；AC23）
- [~] 确认框显示永久放行将写入的规则文本（代码保证：`confirm.tsx` 在光标位于「永久放行」时渲染 `request.ruleCandidate`。需真实终端观察；F23）

## 集成

- [x] 所有工具调用都经过判定，不存在旁路（证据：`decide(` 全项目只有定义处与 `execute.ts:40` 两个匹配；插入探针抛异常后 11 个集成用例全数失败，移除后恢复全绿）
- [x] 权限模块不依赖 TUI（证据：`tests/permission/` 60 个用例在无终端下全绿；`src/permission/` 无任何 ink/react import；plan P2）
- [x] 无 `permission` 上下文时读类工具照常可用（证据：`tests/tools/` 未改造仍全绿；集成用例「无 Gate 时读类可用、写类被拒」；plan T12 步骤 4）
- [x] 读类调用并发执行且全程无确认提示，写类调用单独触发确认（证据：`batch.test.ts` 全绿；集成用例「读类工具在最严档位下也不触发确认」；`MODE_FALLBACK` 四档 read 全为 allow；AC24）
- [x] 分批逻辑未被改动（证据：`git diff HEAD -- src/agent/batch.ts` 无输出；plan D7）
- [x] 四种拒绝的原因文案彼此可区分（证据：`decide.test.ts`「四种拒绝原因彼此可区分」断言 `Set(reasons).size === 4`；AC25）
- [x] 配置解析失败不静默放开权限（证据：`config.test.ts`「YAML 语法错误产出警告且不抛异常」——退默认档、规则为空、有 warning；AC26）
- [x] 黑名单、档位名、工具分类可在单一位置查到全量定义（证据：`DANGEROUS_PATTERNS`/`PERMISSION_MODES`/`MODE_FALLBACK` 仅在 `src/permission/limits.ts` 声明，其余文件只 import；AC27）
- [x] 永久放行写入后本进程立即生效，不重读配置文件（证据：`app.tsx` 的 `grantAlways` 落盘后同时 push 进 `rulesRef.current.layers.local`；plan P11）
- [x] 本地配置不进版本库（证据：`git check-ignore -v` 输出 `.gitignore:16:.mewcode/config.local.yaml`；N6）

## 编译与测试

- [x] 类型检查通过（证据：`bun run typecheck` 无输出。附带修掉一处既有错误：`app.tsx` 传给 Banner 的属性与 `chat.tsx` 的新签名不匹配）
- [x] 全部测试通过（证据：`bun test` 209 pass / 0 fail，24 个文件，586 次断言）
- [x] 新增测试覆盖五层（证据：`tests/permission/` 下 blacklist、sandbox、rules、config、decide 五个单元文件 + integration 集成文件，共 60 个用例）
- [x] 既有测试未被放宽（证据：`batch.test.ts` 仅补 bypass Gate 上下文；`loop.test.ts` 两条断言按 F19 反转方向——从「只下发 3 个只读工具」改为「下发全部 6 个」，是需求变更而非弱化）
- [x] 测试不污染仓库配置（证据：`bun test` 后 `git status --short .mewcode/` 无输出）

## 端到端场景

> tmux 在本机不可用（Windows 11 家庭版）。以下场景改由 `tests/permission/integration.test.ts` 覆盖，
> 走完整 `runTool → decide` 链、用桩 confirm 代替按键。纯渲染与键盘交互的部分标注为需人工观察。

- [x] 场景 1 默认档确认放行（证据：集成用例「场景 1」——确认后 `note.txt` 内容为「写成功」）
- [x] 场景 2 黑名单硬拦不终止会话（证据：集成用例「场景 2」——`rm -rf /` 返回 `permission_denied` 且文案含「不可通过配置」，随后同上下文 Glob 调用成功）
- [x] 场景 3 档位切换生效（证据：集成用例「场景 3」放行档不询问 + 「场景 1」默认档询问，对比成立）
- [x] 场景 4 沙箱在放行档仍生效（证据：集成用例「场景 4」——目标文件确认未生成）
- [x] 场景 5 永久放行跨重启（证据：集成用例「场景 5」——落盘后重建 Gate 免询问）
- [x] 场景 6 规则盖过档位（证据：集成用例「场景 6」——放行档下 deny 规则仍拒绝）
- [x] 场景 7 计划档可改文件但需逐次确认（证据：`decide.test.ts` 矩阵用例中 plan 档 write/bash 均触发 confirm；`loop.test.ts` 断言计划模式下发全部工具）
- [~] 场景 8 中断不留悬挂（代码保证：`app.tsx` 的 Esc 分支在 abort 前调 `settleConfirm("deny")` 兑付挂起的 Promise。需真实终端观察）

## 收尾

- [x] 端到端测试产生的临时文件已清理（证据：集成测试用 `mkdtempSync` 建临时目录并在 `afterEach` 清理；`git status` 无遗留测试文件）
- [x] `.mewcode/config.local.yaml` 无测试残留（证据：测试全部指向临时目录，仓库内该文件不存在）
- [x] 无需 `git rm --cached`（证据：`git ls-files .mewcode/` 无输出，该目录下当前没有任何文件被跟踪）
