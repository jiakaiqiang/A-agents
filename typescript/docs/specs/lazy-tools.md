# 延迟工具加载（Lazy MCP Tools）规格

状态：草案 v1（SDD 驱动，先于实现）
关联模块：src/mcp/*、src/tools/registry.ts、src/tools/execute.ts、src/agent/loop.ts、src/prompt/reminder.ts

## 1. 背景与问题

当前实现（manager.ts connectOne）在启动时把每个 MCP Server 的全部工具
以完整 schema（name + description + input_schema）注册进 ToolRegistry；
agent loop 每次迭代（loop.ts:111 definitionsFor）都把全量工具定义随请求
下发给 LLM。工具数量增长后：

- 每轮请求携带全部 schema，token 成本与注册量成正比，与实际使用量无关；
- 大量未使用工具的 schema 挤占上下文窗口。

目标：把"声明成本"从注册量解耦为使用量——延迟工具只占一行目录，
被使用（发现）后才以完整 schema 进入工具列表。

## 2. 术语

- **延迟工具（lazy tool）**：注册期只登记元信息（名字、一句话描述、
  loader），不进入 LLM 工具列表的 MCP 工具。
- **已发现（discovered）**：loader 已执行、完整 Tool 已进入 ToolRegistry
  active 集合的延迟工具。单一事实来源：在 registry 即已发现。
- **懒池（lazy pool）**：LazyToolIndex 中全部未发现条目的集合。
- **目录（catalog）**：每轮以 system-reminder 注入的延迟工具名字列表。
- **toolSearch**：内置元工具。模型传入工具名，返回完整定义并触发发现。

## 3. 功能需求

- LF1 注册期分流：McpManager.connectOne 对每个 Server 的 tools/list 结果
  全量调用 registry.registerLazy 登记延迟条目；不再直接 register。
  重名解析规则（原名 → Server名_前缀 → 跳过并告警）原样作用于懒池。
- LF2 toolSearch 元工具：参数 { query: string }（必填）。
  执行时按序判定：
  a) query 精确命中 registry 已注册工具 → 返回该工具已加载提示与定义，
     不重复发现；
  b) 精确命中懒池 → 执行 loader 生成完整 Tool，registry.register，
     懒池移除该条目；返回完整定义（name/description/参数 schema）与
     "已加载，下一轮可直接调用"提示；
  c) 均未命中 → 对懒池与已注册名做包含匹配，返回候选列表（无候选时
     返回未找到）。
  toolSearch 为 readOnly 工具（无副作用，可并发、计划模式可用）。
- LF3 已发现工具出现在工具列表：registry.discover 后，下一次
  definitionsFor 生成的 tools 数组自动包含该工具完整 schema
  （loop.ts 每次迭代重建 tools，无需额外改动）。
- LF4 目录 reminder：每轮模型请求注入一条 system-reminder，列出未发现
  延迟工具的名字与一句话描述，并指引"需要时先调 toolSearch"。
  懒池为空时不注入。目录内容每轮重算（随发现动态收缩）。
- LF5 安全网（自动补载）：runTool 收到 registry 未命中的工具名时，
  先查懒池：
  a) 命中且参数通过 schema 校验 → 自动发现并直接执行本次调用；
  b) 命中但参数不过校验 → 自动发现，返回 invalid_params 错误并附
     完整 schema，要求模型按 schema 重发；
  c) 未命中 → 维持现状 fail("unknown_tool")。
- LF6 生命周期：disposeAll 关闭全部连接并 markDisconnected 所有 client；
  懒池条目保留在 registry（单一事实来源，LN1）——发现后调用会得到
  "MCP Server 已断开" 的明确失败并回灌，不产生僵尸进程。
- LF7 装配：createDefaultRegistry 可选挂载 toolSearch（需要 registry 与
  lazyIndex 引用，装配点在 main.tsx / manager 创建之后）。
  无 MCP Server 配置时系统行为与现状完全一致（不注册 toolSearch 亦可，
  但为简化统一注册）。

## 4. 非功能需求

- LN1 单一事实来源："是否已发现"只看 registry，懒池不保存重复状态，
  避免双写不一致。
- LN2 既有 API 兼容：ToolRegistry.register/get/list/definitionsFor 语义
  不变；现有测试不因本特性失败（允许因报告语义调整更新断言）。
- LN3 缓存影响可接受：发现新工具导致 tools 数组变化、缓存前缀失效
  一次属预期成本，不做增量缓存优化（评估见 §6）。
- LN4 目录体积：每个未发现条目一行（名字 + 一句话描述）；
  description 超 80 字符截断。
- LN5 loader 失败可降级：loader 抛错时 discover 返回失败信息，
  懒池条目保留（下次可重试），registry 不残留半成品。

## 5. 验收标准（测试可执行）

- LA1 注册期：connectAll 后 registry 无 MCP 工具直接注册；
  lazyIndex.size 等于该 Server 工具总数（重名条目按前缀规则入池）。
- LA2 toolSearch 精确发现：对懒池中的工具执行 toolSearch →
  registry.get 命中、懒池 size 减一、返回内容含完整 schema 文本。
- LA3 toolSearch 幂等：对已注册工具执行 toolSearch → 不改变懒池，
  返回"已加载"。
- LA4 toolSearch 未命中：query 无匹配 → 返回候选或未找到，
  懒池不变。
- LA5 发现后进入工具列表：discover 后 definitionsFor() 的输出包含
  新工具的完整定义。
- LA6 安全网直通：模型直接调用懒池工具且参数合法 → 一次调用完成
  发现+执行（结果 ok），懒池同步收缩。
- LA7 安全网拦截：参数不合法 → errorKind=invalid_params、content 含
  schema、工具已被发现（registry 命中）。
- LA8 目录 reminder：懒池非空时每轮 reminders 含目录文本
  （含工具名与指引）；懒池空时不注入。
- LA9 回归：bun typecheck 通过；全量 bun test 通过（含既有 MCP 用例
  更新后的断言）。

## 6. 边界与成本（设计备忘）

- 发现往返多一轮请求；每次发现使提示词缓存前缀失效一次。
  适用前提：会话实际使用的工具数远小于注册总数。
- 延迟工具总数低于阈值（如 10）时收益为负，可后续加自动退化开关
  （本期不做，LF7 保留统一行为）。
- 计划模式：MCP 工具 readOnly=false（adapter.ts 既有约定），
  发现后仍逐次走权限确认，行为不变。

## 7. 实施顺序

1. 规格文档（本文件）
2. LazyToolIndex + registry 扩展
3. toolSearch 元工具 + 装配
4. manager 分流 + execute 安全网
5. 目录 reminder + loop 动态注入
6. 测试与回归（对照 LA1–LA9 逐条验收）
