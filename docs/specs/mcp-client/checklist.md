# MCP 客户端 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。
> 验证命令统一在 `typescript/` 目录下执行。

## 实现完整性

- [x] MCP 配置解析支持 map 声明（验证：`bun test tests/config.test.ts`——stdio/http 各一、字段齐全）
- [x] `${VAR}` 展开按「Server env 前置 → 进程变量」顺序，未定义出警告并展开为空串（验证：`bun test tests/config.test.ts`）
- [x] JSON-RPC 请求按 id 异步配对，并发乱序回包不错位（验证：`bun test tests/mcp/jsonrpc.test.ts`）
- [x] Server 通知（无 id）被静默丢弃（验证：`bun test tests/mcp/jsonrpc.test.ts`）
- [x] stdio 传输能起子进程并按行收发（验证：`bun test tests/mcp/transport-stdio.test.ts`——echo 往返）
- [x] http 传输兼容 JSON 与 SSE 两种响应（验证：`bun test tests/mcp/transport-http.test.ts`——Bun.serve 桩）
- [x] 三步握手（initialize → initialized → tools/list）完整执行（验证：`bun test tests/mcp/client.test.ts`——桩检查消息序列）
- [x] MCP 工具描述带 `[MCP: Server名]` 前缀下发（验证：`bun test tests/mcp/adapter.test.ts`）
- [x] 多 text 块按序拼接，非 text 块记占位符（验证：`bun test tests/mcp/adapter.test.ts`）
- [x] `isError:true` 转失败结果回灌（验证：`bun test tests/mcp/adapter.test.ts`）

## 集成

- [x] 多 Server 并行连接，单个失败只降级不影响其他（验证：`bun test tests/mcp/manager.test.ts`——一个超时一个 ok）
- [x] 握手超时的 Server 被跳过，MewCode 正常启动（验证：`bun test tests/mcp/manager.test.ts`；手动项见端到端）
- [x] 与内置工具重名的 MCP 工具注册为 `Server名_工具名` 且可被调用（验证：`bun test tests/mcp/manager.test.ts`）
- [x] `enabled: false` 的 Server 零连接尝试（验证：`bun test tests/mcp/manager.test.ts`）
- [x] MCP 工具调用走完整五层权限判定：默认档弹确认、allow 规则放行、deny 规则 bypass 下仍拒（验证：`bun test tests/mcp/` 权限集成用例）
- [x] 确认框展示来源 Server，永久放行写入 `Server名.工具名(...)` 规则（验证：`bun test tests/mcp/` 权限集成用例 + `tests/permission/rules.test.ts`）
- [x] MCP 出参走统一截断脱敏（验证：`bun test tests/mcp/`——超长 text 块带 `[truncated` 标记）
- [x] 内置六工具的权限行为零变化（验证：`bun test tests/permission/` 全绿）
- [x] 既有全部测试零回归（验证：`bun test` 全绿）
- [x] 进程退出后 stdio 子进程无残留（验证：`bun test tests/mcp/manager.test.ts`——pid 存活探测）

## 编译与测试

- [x] 项目编译无错误（验证：`bun run typecheck` 无输出）
- [x] 全部单元测试通过（验证：`bun test` 全绿）
- [x] 新增测试覆盖协议、传输、客户端、适配、管理器五个层面（验证：`tests/mcp/` 下五个测试文件存在且全绿）

## 端到端场景

> tmux 在本机不可用（Windows 11 家庭版）。场景以真实 stdio MCP Server 桩
> （`tests/mcp/fixtures/` 的最小 Server）+ 临时配置走 `bun run start` 手动观察，
> 协议与生命周期行为已由集成用例覆盖的部分标注对应测试。
> 实测方式：tmux/交互终端不可用，改用非交互探针脚本走 main 同款链路
> （loadConfig → connectAll → 注册表断言 → process.exit 后孤儿进程探测）。

- [x] 场景 1：配置一个 stdio MCP Server 启动 MewCode → 开场系统消息显示「已注册 N 个工具」→ 让模型调用其中之一 → 默认档弹确认框（含 Server 来源）→ 选「本次放行」→ 工具结果正确回灌、本轮对话继续（覆盖 AC4、AC10、AC13）——连接报告文案已验证（探针输出「MCP fx：已注册 2 个工具」）；确认框交互为渲染层，由 `tests/mcp/permission-integration.test.ts` 的 confirm 回调链路覆盖
- [x] 场景 2：对同一工具选「永久放行」→ 退出 → 检查 `.mewcode/config.local.yaml` 新增 `allow: Server名.工具名(...)` → 重启后同调用不再询问（覆盖 AC12）——`appendLocalRule` 落盘与重启免询问由权限既有测试 + 集成用例的 ruleCandidate 断言覆盖；落盘文件格式未变
- [x] 场景 3：kill 掉 stdio Server 子进程后继续会话 → 让模型调用该 Server 工具 → 收到「MCP Server 已断开」失败结果，对话未终止（覆盖 AC9）——`tests/mcp/manager.test.ts` 断开用例 + `tests/mcp/client.test.ts` 断开语义用例
- [ ] 场景 4：配置一个指向不通地址的 http Server → 启动 → 出现失败系统消息，其余 Server 正常、聊天可用（覆盖 AC8、AC15）——降级逻辑由 `manager.test.ts`（超时/failed 报告独立）覆盖；http 不通地址的实机启动待有交互终端时人工复核
- [x] 场景 5：退出 MewCode → `tasklist`/进程探测确认无残留子进程（覆盖 AC6）——探针硬退出后 `wmic` 探测无 mcp-server 孤儿进程

## 收尾

- [x] 端到端产生的临时配置与临时文件已清理（验证：`git status` 无新增遗留）
- [x] `.mewcode/config.local.yaml` 无测试残留规则（验证：文件不存在或不含测试规则）
