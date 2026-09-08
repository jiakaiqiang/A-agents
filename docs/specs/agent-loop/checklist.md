# Agent Loop Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。
> 命令均在 `typescript/` 目录下执行。

## 循环编排

- [ ] 模型第一次响应不含工具调用时只发起一次请求（验证：`bun test tests/agent/loop.test.ts`，
  纯文本用例断言 `done.iterations === 1`、`reason === "complete"`、`toolsExecuted === 0`）
- [ ] 模型连续三次要工具、第四次收尾时共四次请求、三批工具（验证：同上，多迭代用例断言
  `iterations === 4`、`toolsExecuted === 3`，最终答复取自第四次响应）
- [ ] 每次含工具的迭代在历史中留下配对的调用与结果（验证：遍历 `getMessages()`，每条带
  `toolUses` 的消息后紧跟一条带 `toolResults` 的消息，两侧 id 列表逐项相等，无孤立项）
- [ ] 迭代上限生效且循环必然终止（验证：用永远返回工具调用的假客户端 + `maxIterations: 5`
  运行，断言请求次数恰为 5、`reason === "max_iterations"`，进程不挂起）
- [ ] 非自然停止后历史仍可继续下一轮（验证：撞上限后 `addUserMessage("继续")`，
  `buildAnthropicMessages(getMessages())` 结果中不存在相邻两条 `role === "user"`）

## 停止条件

- [ ] 五种停止原因各自可区分（验证：五个用例分别断言 `done.reason` 为 `complete` /
  `max_iterations` / `cancelled` / `invalid_tools` / `stream_error`）
- [ ] 模型流中取消不抛异常、会话可继续（验证：脚本 throw `AbortError`，断言 `runLoop`
  正常产出 `done`、`reason === "cancelled"`，随后再跑一轮仍能正常完成）
- [ ] 工具批次中取消时全部调用仍与调用配对（验证：工具阶段前 abort，断言结果条数等于
  `toolUses` 条数，未执行的 `errorKind === "cancelled"`）
- [ ] 连续未知工具达阈值才停、中途有真工具则归零（验证：两个用例——连续三次全未知 →
  `invalid_tools`；第二次混入一个真工具 → 循环继续、请求次数超过 3）
- [ ] 流错误被兜住不冒泡（验证：脚本 throw `Error("boom")`，断言 `reason ===
  "stream_error"`、`done.errorMessage` 含 `boom`，`for await` 外无异常逃出）

## 事件流

- [ ] 编排层与界面零耦合（验证：`grep -rn "tui" src/agent/` 无输出；`runLoop` 参数列表中
  不存在函数类型的字段）
- [ ] 六类事件在一轮含工具的运行中都出现（验证：收集事件数组，断言类型集合包含 `text`、
  `tool_start`、`tool_end`、`usage`、`progress`，以及 `notice` 或 `done`）
- [ ] 事件顺序符合约定（验证：断言同一迭代的 `progress` 下标小于该迭代首个 `text` /
  `tool_start` 下标；同一 `toolId` 的 `tool_start` 早于 `tool_end`；`done` 为末项）

## 流式收集器

- [ ] 单次请求只消费一次流且双路内容一致（验证：拼接 `text` 事件的文本，与
  `CollectedResponse.text` 严格相等）
- [ ] 完整响应对象内容齐全（验证：断言可分别取到正文、`thinkingBlocks`、`toolUses`、
  `stopReason`、`usage`；带 `parseError` 的调用保留失败原因）
- [ ] 参数解析失败的调用不执行（验证：`parseError` 用例中该调用结果为
  `errorKind === "invalid_params"`，且工具的 `execute` 未被调用）

## 工具批次调度

- [ ] 六个工具的并发安全性声明正确（验证：`bun test tests/tools/registry.test.ts` 断言
  `listReadOnly()` 为 `["Read","Glob","Grep"]`，非只读为 `["Write","Edit","Bash"]`）
- [ ] 调度器不按工具名硬编码（验证：`grep -n "\"Read\"\|\"Write\"\|\"Bash\"" src/agent/batch.ts`
  无输出）
- [ ] 保序分段划分正确（验证：`[Read, Write, Read, Grep]` 得到三个批次
  `[并发:Read] / [串行:Write] / [并发:Read,Grep]`；全只读 → 一个并发批；全副作用 →
  等量串行批；未知工具 → 单独串行批）
- [ ] 并发批真并发且结果保序（验证：两个各 sleep 60ms 的只读桩工具同批，总耗时 < 120ms；
  结果数组顺序与输入顺序一致，重复运行顺序稳定）
- [ ] 并发批内单个失败不影响同批与循环（验证：一个桩工具 throw，断言同批另一个仍
  `ok === true`，失败那条 `errorKind === "exec_failed"`，循环继续到下一迭代）
- [ ] 串行批副作用对后续批可见（验证：临时目录内先 Write 再 Read 同一文件，Read 结果含
  新写入内容；测试结束目录被清理）

## Plan Mode

- [ ] 计划模式只暴露只读工具（验证：`mode: "plan"` 运行一轮，假客户端记录到的工具定义
  为 3 条且名称为 Read/Glob/Grep；`mode: "execute"` 时为 6 条）
- [ ] 计划模式下循环机制不变（验证：计划模式用例中模型连续两次调用只读工具后产出文本，
  `iterations === 3`、`reason === "complete"`）
- [ ] 提示词按模式变化（验证：`buildSystemPrompt(env, { tools, mode: "plan" })` 输出含
  计划模式约束；`mode: "execute"` 时不含；两者都不含「每轮最多执行一个工具」）
- [ ] `/plan` 与 `/do` 不触发请求、不进历史（验证：tmux 中输入 `/plan`，观察无 spinner、
  无 token 变化；随后输入普通消息，模型收到的历史里没有 `/plan` 文本）
- [ ] 当前模式在界面可见（验证：tmux 中状态栏在 `/plan` 后显示「计划」，`/do` 后显示
  「执行」）
- [ ] 默认执行模式且切换不清空历史（验证：tmux 中启动后状态栏显示「执行」；先聊一句，
  再 `/plan`、再 `/do`，观察先前的对话内容仍在界面上，且模型后续答复能引用之前的内容）

## 编译与测试

- [ ] 项目类型检查无错误（验证：`bun run typecheck` 退出码 0、无输出）
- [ ] 全部测试通过（验证：`bun test` 全绿，无 skip、无 fail）
- [ ] 旧编排逻辑已彻底移除（验证：`grep -rn "runTurn\|TurnCallbacks\|agent/turn" src tests`
  无输出）
- [ ] 未引入新依赖（验证：`git diff package.json` 无 dependencies 变更）

## 端到端场景

- [ ] 场景 1（多迭代自主完成）：tmux 启动 MewCode，输入「读一下 src/tools/limits.ts，
  然后告诉我 Bash 超时是多少」→ 观察到工具行按迭代依次出现、spinner 显示轮次递增、
  最终答复给出正确数值，全程无需追问
- [ ] 场景 2（并发批可见）：输入「同时看看 src/agent 下有哪些文件，并搜一下代码里
  哪儿用了 MAX_ITERATIONS」→ 观察到两条工具行几乎同时出现并先后补上摘要，正文答复
  覆盖两项结果
- [ ] 场景 3（Plan Mode 两段式）：输入 `/plan` → 状态栏变「计划」→ 输入「说说
  batch.ts 可以怎么加并发上限」→ 观察到只有读类工具行、答复是计划文本而非改动；
  输入 `/do` → 状态栏变「执行」→ 输入「按上面的计划改」→ 观察到出现 Edit 工具行
- [ ] 场景 4（中断后可继续）：在多迭代运行中按 Ctrl+C 之外的取消路径中断本轮 →
  观察到中断提示、界面恢复可输入 → 再输入一条普通消息 → 观察到新一轮正常完成、
  不报协议错误
- [ ] 场景 5（纯文本向后兼容）：输入「你好」→ 观察到单次请求、流式正文、markdown
  渲染，与本章之前的交互无差异，无工具行、无轮次提示

## 安全与呈现

- [ ] 事件流不回显密钥（验证：让模型执行含 `--token=sk-xxxx` 的命令，观察工具行摘要与
  结果摘要中出现 `[redacted]`，原始值不出现在界面任何位置）
- [ ] 多迭代正文不互相覆盖（验证：场景 1 中上一次迭代的正文在下一次迭代开始后仍留在
  界面上）
- [ ] 运行期间显示轮次与阶段（验证：场景 1 中 spinner 上的轮次随迭代递增，阶段文案在
  「等待模型」与「执行工具」之间切换）
- [ ] 用量为本轮累计（验证：场景 1 中状态栏 token 数随迭代持续累加，不在新迭代开始时
  归零）
- [ ] 停止原因措辞可区分（验证：分别触发上限中止与用户中断，界面提示文案不同）
