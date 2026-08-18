# 工具系统与受限单轮闭环 Checklist 验收记录

> 验证方式：`bun run typecheck`、`bun test`（77 pass / 0 fail，13 个文件），
> 以及针对真实 OpenAI 兼容端点（provider `gpt-5.6-sol`）的三个端到端场景。
> tmux 不可用：当前 Windows 环境未安装 tmux，端到端改用编排层脚本对接真实端点验证。

## 实现完整性 — 工具抽象与注册

- [x] 六个工具都能按名称取到，且各自可读出非空描述与对象型参数 Schema（证据：`tests/tools/registry.test.ts` 断言 `["Read","Write","Edit","Bash","Glob","Grep"]` 且逐个校验 description 与 `parameters.type`）(AC1)
- [x] 坏输入下返回统一失败结果、无未捕获异常（证据：各工具测试覆盖越界/类型错误/空参数，`tests/tools/registry.test.ts` 额外验证异常被转为 `exec_failed`）(AC1)
- [x] 未登记工具名返回 `unknown_tool`（证据：`registry.test.ts` "未登记工具返回 unknown_tool"）(AC2)
- [x] 三协议导出在名称、描述、必填项、参数键集合上完全一致（证据：`registry.test.ts` 逐项比对三份导出）(AC3)
- [x] 新增第七个工具后三份定义各自 +1，其他模块无改动（证据：`registry.test.ts` "新增第七个工具自动出现在三协议定义中"）(AC4)

## 实现完整性 — 读文件

- [x] 返回带真实行号的文本（证据：`tests/tools/read.test.ts` 断言 `1\tone`、`3\tthree`）(AC5)
- [x] offset/limit 只返回指定范围（证据：同文件 "支持 offset 和 limit"）(AC6)
- [x] 不存在/目录/二进制三类失败分类可区分；越界由 `paths.test.ts` 覆盖（证据：`read.test.ts` 三个用例分别断言 `not_found`/`not_found`/`exec_failed`）(AC7)
- [x] 超过默认行数上限时截断并标注（证据：2005 行文件的 summary 含 `total 2005 lines`）(AC8)

## 实现完整性 — 写文件

- [x] 创建文件并自动创建父目录（证据：`tests/tools/write.test.ts` 写入 `nested/a.txt` 后读回一致）(AC9)
- [x] 覆盖写入内容完全一致，摘要含动作与规模（证据：同文件 "覆盖已有文件"，summary 为 `updated, N lines`）(AC10)
- [x] 越界与写入目录返回结构化错误且目录未被破坏（证据：同文件两个失败用例）(AC11)

## 实现完整性 — 改文件

- [x] 唯一匹配替换成功、其余内容不变（证据：`tests/tools/edit.test.ts` 读回完整内容比对）(AC12)
- [x] 零匹配不修改文件（证据：同文件断言 `not_found` 且内容不变）(AC13)
- [x] 多匹配未开全量替换时不改文件且错误含匹配数（证据：同文件断言 `match_count` 且 content 含 `3`）(AC14)
- [x] 全量替换替换所有命中并返回次数（证据：同文件断言 `detail.matches === 3`）(AC15)

## 实现完整性 — 执行命令

- [x] 正常命令返回输出与退出码 0，不判错（证据：`tests/tools/bash.test.ts` 断言 `exitCode === 0`）(AC16)
- [x] 非零退出不自动判错（证据：同文件断言 `ok === true` 且 `exitCode === 3`）(AC17)
- [x] 超时被终止并标记（证据：同文件 timeout=100ms 用例断言 `errorKind === "timeout"`）(AC18)
- [x] 无法启动返回执行失败（证据：`registry.test.ts` 的异常兜底 + Bash `error` 事件分支返回 `exec_failed`）(AC19)
- [x] 大量输出被截断标注（证据：`bash.test.ts` 20000 行输出用例断言 content 含 `[truncated]`）(AC20)

## 实现完整性 — 按模式找文件

- [x] 返回相对路径列表，支持限定搜索根目录（证据：`tests/tools/glob.test.ts` "支持搜索根目录"）(AC21)
- [x] `.git`/`node_modules`/`dist` 下文件不出现（证据：同文件 "忽略版本控制、依赖与构建目录"）(AC22)
- [x] 按修改时间倒序；超上限截断标注（证据：同文件 utimes 用例断言 `["new.ts","old.ts"]`；上限逻辑在 `glob.ts` 统一处理并标注）(AC23)
- [x] 无匹配为成功空结果；根目录越界返回错误（证据：同文件两个用例）(AC24)

## 实现完整性 — 搜代码内容

- [x] 命中含路径、行号、行内容（证据：`tests/tools/grep.test.ts` 断言 `a.ts:2:TODO: fix`）(AC25)
- [x] 路径范围与文件名过滤同时生效（证据：同文件 "路径范围和文件过滤同时生效"）(AC26)
- [x] 非法正则返回参数错误；无命中为成功空结果；上限截断由 `grep.ts` 统一标注（证据：同文件对应用例）(AC27)

## 安全与资源边界

- [x] 绝对路径、`..`、符号链接三种越界形式被拒（证据：`tests/tools/paths.test.ts` 三个用例；工具层统一走 `resolveInside`）(AC28)
- [x] 命令工作目录固定为启动目录（证据：`bash.ts` 恒定传入 `cwd: context.workDir`，命令内 `cd` 不影响后续调用）(AC29)
- [x] 参数不合法时工具未被调用（证据：`registry.test.ts` "参数不合法时不执行工具" 断言 `called === false`）(AC30)
- [x] 超限结果被截断并标注保留规模（证据：同文件断言 content 长度 ≤ 上限且含 `[truncated:`）(AC31)
- [x] content 与 summary 均脱敏；命令内联密钥在工具行脱敏（证据：`registry.test.ts` 脱敏用例 + `bash.test.ts` "工具行中的内联密钥被脱敏" + `redact.test.ts` 覆盖八类密钥模式）(AC32)

## 集成 — 协议层与提示词

- [x] 分片参数被拼接为同一次调用（证据：三个 client 的 `input_json_delta`/`function_call_arguments.delta` 累积后在完成事件统一解析；真实端点跑通工具调用）(AC33)
- [x] 参数无法解析时不执行工具（证据：`turn.ts` 对 `parseError` 短路为 `invalid_params`，`events.ts` 三处 client 均带出 `parseError`）(AC34)
- [x] 每个调用有且仅有一条按 ID 配对的结果；真实端点请求未报错（证据：`tests/agent/turn.test.ts` 多工具用例断言 3 条结果与 ID 顺序；真实端点三场景历史均为 `assistant(toolUses=X) → user(toolResults=X)`）(AC35)
- [x] 系统提示词含工具清单与本期约束（证据：打印提示词输出六个工具名 + "每轮最多执行一个工具调用"等三条约束）(AC36)

## 集成 — 单轮闭环

- [x] 无工具时只请求一次（证据：`turn.test.ts` 断言 `requestCount === 1`）(AC37)
- [x] 一个工具时请求 2 次、执行 1 次、第二次不带工具（证据：同文件断言 `requests[1]` 为 `[]`；真实端点 read 场景 `requestCount=2 toolsExecuted=1`）(AC38)
- [x] 多工具只执行第一个，其余回灌失败并提示（证据：同文件断言 `toolsExecuted === 1`、后两条 `isError`、notice 含"跳过"）(AC39)
- [x] 续答阶段再调工具不执行、无第三次请求、调用块不入历史（证据：同文件断言 `requests` 长度为 2、notice `isError` 为真、历史末条为纯文本 assistant）(AC40)
- [x] 中断后不抛异常且配对完整（证据：同文件中断用例断言 `aborted === true` 且 toolUses/toolResults 均为 `t1`）(AC41)
- [x] 用量为两次请求累计（证据：`turn.ts` 用 `accumulatedUsage` 跨两次请求累加后回调）(AC42)

## 集成 — 终端呈现

- [x] 工具行在解析完成时立即出现（证据：`app.tsx` 的 `onToolStart` 在 `runTool` 之前 push 工具行；真实端点 bash 场景可见 `[tool start]` 先于 `[tool end]`）(AC43)
- [x] 工具行形如 `● Read(path)` 并在完成后补摘要，失败可区分（证据：`app.tsx` 用 `symbols.dot` 前缀、按 `toolId` 原地补 `— summary`，`chat.tsx` 失败时改用 `brand.error`）(AC44)
- [x] 参数与结果摘要单行化截断，完整输出不进聊天正文（证据：`execute.ts` 对 summary 施加单行化 + 72 字符上限；`chat.tsx` 工具行不走 markdown 渲染）(AC45)
- [ ] 长命令期间界面保持响应并可中断 — 未在真实 TTY 交互中验证（原因：环境无 tmux，非 TTY 管道运行会触发 Ink raw mode 限制）。已在编排层验证中断路径（AC41）(AC46)

## 编译与测试

- [x] 类型检查无错误（证据：`bun run typecheck` 退出码 0）(AC47)
- [x] 全部单元测试通过（证据：`bun test` → 77 pass / 0 fail / 199 expect，13 个文件）(AC47)
- [x] 测试在临时目录进行且无残留（证据：各文件 `afterEach` 递归清理 `mkdtempSync` 目录；`git status` 无临时文件）(AC48)
- [x] Windows 上通过测试，路径对模型呈现为 POSIX 风格（证据：本次全部测试在 Windows 11 执行；`paths.test.ts` 断言 `a/b.txt`，Glob/Grep 结果经 `toPosix` 转换）(AC49)
- [x] 未引入新第三方依赖（证据：`package.json` 未改动，Glob/Grep 用 Bun 内置 `Bun.Glob`，校验器自写）(AC50)

## 端到端场景

- [x] 场景 1（读文件）：提问"读取 package.json，告诉我 version 字段的值" → 工具行 `Read(package.json)` → `35 lines` → 答复 `version 字段的值是 "0.1.0"`；`requestCount=2 toolsExecuted=1`，历史 `assistant(toolUses=X) → user(toolResults=X) → assistant`
- [x] 场景 2（改文件失败重试）：对含 3 处 `const` 的文件调 Edit 且不带 `replace_all` → 工具行失败摘要 `找到 3 处匹配，期望恰好 1 处` → 答复解释原因并说明文件未修改；文件确实未变
- [x] 场景 3（执行命令）：要求运行 `bun run typecheck` → 工具行 `Bash(bun run typecheck) — exit 0` → 答复引用退出码 0
- [x] 场景 4（纯文本回归）：`turn.test.ts` "无工具时只请求一次" 断言仅一次请求且历史末条为纯文本 assistant，呈现路径与上一章一致
- [ ] 场景 5（中断恢复）：未在真实 TTY 中手动触发 Ctrl+C 验证（原因同 AC46）。编排层等价路径已由 `turn.test.ts` 中断用例覆盖：不抛异常、配对完整、可继续下一轮

## 未完成项汇总

- AC46 与端到端场景 5 需在真实交互终端手动验证（当前环境无 tmux，非 TTY 运行受 Ink raw mode 限制）。建议在本机终端执行 `bun run src/main.tsx`，发起一次长命令后按 Ctrl+C 观察界面响应与恢复。
