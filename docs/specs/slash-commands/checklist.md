# 斜杠命令系统 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。
> 验证命令在 typescript/ 下执行。「单测」指 `bun test tests/commands/`，「Ink 测试」指以子进程驱动真实 Ink 界面的命令系统测试，「手工」指在真实终端 `bun run start` 中操作。
> 验收记录：`bun run typecheck` 零错误；`bun test` 454 pass / 0 fail（基线 389 + 新增 65）；真实 Ink fixture `tests/commands/fixtures/tui.tsx` 通过，并做过两次变异检验（去掉恢复时的 display 优先、去掉 Esc 守卫，fixture 均在对应断言处失败）。`src/commands/` 下无 ink / react / tui 导入。端到端场景 1～5 与手工 /compact 由用户在真实终端按操作脚本验收，反馈全部通过（本机无 tmux）。

## 注册与启动

- [x] 名称含大写、含空格、为空，或提示词类缺模板、本地/界面类缺执行逻辑时，登记失败且错误信息指明该命令（验证：单测；AC1）
- [x] 名称撞名称、名称撞别名、别名撞别名、仅大小写不同的撞名，错误信息同时含冲突双方主名（验证：单测；AC2）
- [x] 启动期遇到命名冲突：stderr 输出冲突信息、退出码 1、不进入界面；无冲突时正常继续（验证：单测中起子进程注入冲突定义，观察退出码与输出；AC2、N6）
- [x] 14 个内置命令全部登记成功，列出的主名恰为 help、status、session、memory、permission、clear、compact、plan、do、accept-edits、bypass、resume、exit、review（验证：单测；AC3）

## 解析与分流

- [x] `/HELP` 与 `/help` 输出一致；`/help   status ` 解析为命令 help、参数 status；多行输入的参数保留换行（验证：单测；AC4）
- [x] 只含空白的输入不产生任何消息、不发请求（验证：单测；AC6）
- [x] `/foo` 显示「未知命令：/foo，输入 /help 查看可用命令」，假 provider 请求数不变，对话历史条数不变（验证：单测 + Ink 测试；AC5）
- [x] 普通文本照常送 Agent；除 /review 外任一已知命令执行后请求数为 0（验证：单测 + Ink 测试；AC7）
- [x] 执行过的命令（含未知命令）按 ↑ 能翻出（验证：Ink 测试；AC7）

## 三类执行

- [x] /status、/session、/memory、/permission、/help 执行前后对话历史、档位、会话 ID 不变（验证：单测检查假界面未收到任何改状态的调用；AC8）
- [x] `/review src/tui`：对话区显示 `/review src/tui`；模型收到的用户消息含「git diff」与「审查范围：src/tui」（验证：Ink 测试检查假 provider 收到的请求；AC9）
- [x] /review 所在会话经 /resume 恢复后，对话区显示 `/review src/tui` 而非模板全文；恢复后追问时模型历史中仍是展开文本（验证：Ink 测试；AC9）
- [x] 命令执行逻辑同步抛错或异步失败时显示「命令 /xxx 执行失败：…」，之后发普通消息仍能正常对话（验证：单测 + 手工；AC10、N4）
- [x] `/status foo` 显示 /status 的用法且不执行（验证：单测；AC12）

## 运行中可用性

- [x] Agent 运行中输入 /clear、/compact、/review → 显示「Agent 运行中，请稍后或按 Esc 中断」且不执行，输入框保留内容（验证：单测 + Ink 测试；AC11）
- [x] Agent 运行中输入 /status、/plan → 正常执行（验证：单测 + Ink 测试；AC11）
- [x] Agent 运行中输入普通文本 → 仍提示「仅支持 /resume 等斜杠命令」并保留输入（验证：既有 memory Ink 测试通过；N3）

## 界面控制与状态栏

- [x] 14 个命令都能在不启动终端界面的情况下，用假的界面控制实现逐条执行（验证：单测；AC13、N2）
- [x] 命令模块不依赖终端渲染框架（验证：在 `src/commands/` 下搜索 ink 与 tui 的导入，无结果；N2）
- [x] 启动后状态栏显示 `[DEFAULT]`；/plan → `[PLAN]`；Shift+Tab → `[ACCEPT-EDITS]`；/do → `[DEFAULT]`；/bypass → `[BYPASS]`（验证：Ink 测试 + 手工；AC14）

## 补全与别名

- [x] 输入 `/` 列出全部非隐藏命令；`/s` 列出 /session、/status；`/zz` 无列表；隐藏命令不出现；出现空格后列表消失（验证：单测 + Ink 测试；AC15）
- [x] 列表可见时：↓ 移动高亮；Tab 填入「/status 」；Enter 执行高亮项；Esc 收起列表并保留输入（验证：Ink 测试；AC16）
- [x] Agent 运行中列表可见时按 Esc 只收起列表，不出现「本轮已中断」（验证：Ink 测试；AC16）
- [x] 列表不可见时 ↑ 翻输入历史（验证：Ink 测试；AC16）
- [x] `/q`、`/quit` 与 `/exit` 等价；输入 `/qu` 时列表显示 /exit，Tab 填入「/exit 」；/help 输出含别名（验证：单测 + Ink 测试；AC17）

## 内置命令行为

- [x] /clear 后对话区只剩清空提示、历史为空、会话 ID 改变、旧会话出现在 /resume 列表、档位不变（验证：Ink 测试；AC18）
- [x] /clear 后再发消息，请求中不含清空前的历史（验证：Ink 测试；AC18）
- [x] /memory 无条目时显示「暂无记忆」；有条目时分用户级/项目级列出（验证：单测；AC18）
- [x] /session 输出含会话 ID、消息条数、存档路径与 /resume 提示；/permission 输出含档位标签与四层规则（验证：单测；AC18）
- [x] /status 输出不含密钥值、URL 查询串与完整 URL，端点只显示主机名（验证：单测用带 `?key=SECRET` 的端点断言；AC20、N5）

## 兼容（N3）

- [x] /resume、/exit、/compact、/plan、/do、/accept-edits、/bypass 行为与迁移前一致（验证：既有 memory Ink 测试全部断言通过 + 手工 /compact 一次；AC19）
- [x] 不含 display 字段的旧会话存档恢复后照常显示（验证：单测；N3）
- [x] 模型请求体中不出现 display 字段（验证：Ink 测试检查假 provider 收到的请求 JSON；N5）

## 编译与测试

- [x] `bun run typecheck` 零错误
- [x] `bun test` 全量通过（基线 389 + 新增用例）

## 端到端场景（手工，真实终端 `bun run start`）

- [x] 场景 1：输入 `/` → 看到命令列表；输入 `/st` → 只剩 /status；回车 → 显示状态信息且没有模型请求（状态栏 Token 数不变）
- [x] 场景 2：/plan → 状态栏 `[PLAN]`；发一条需求 → 模型先产出计划；/do → `[DEFAULT]`
- [x] 场景 3：发起一个较长任务，运行中输入 /clear → 被拒；输入 /status → 正常显示；按 Esc → 本轮中断；再 /clear → 屏幕清空、横幅重现、提示新会话
- [x] 场景 4：`/review` → 模型调用 Bash 执行 git diff 并给出审查意见；/clear 后 /resume 选回该会话 → 看到的是 `/review` 而非模板全文
- [x] 场景 5：输入 `/foo` → 未知命令提示；`/help clear` → /clear 的用法；`/q` → 程序退出
