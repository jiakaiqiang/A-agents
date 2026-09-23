# MCP 客户端 Spec

## 背景

MewCode 目前只有 6 个内置工具（Read/Write/Edit/Bash/Glob/Grep），能力封闭在仓库里。工具中心的注册表（ToolRegistry）与权限系统（五层判定）已就绪，配置系统已预留 `mcp_servers` 字段但无任何消费代码。业界已有大量能力以 MCP Server 形式提供（数据库查询、浏览器操作、文档检索等），MewCode 缺少接入通道，只能靠 Bash 拼凑，既不安全也不结构化。

## 目标

- MewCode 启动时自动发现并注册外部 MCP Server 提供的工具，用户只需在配置文件里声明 Server 列表。
- Agent 调用 MCP 工具与调用内置工具完全无感——同一注册表、同一执行入口、同一权限判定。
- 协议层自研（JSON-RPC 2.0 + stdio/Streamable HTTP 两种传输），零新依赖，与项目自研风格一致。
- 单个 Server 故障只降级不拖垮启动，故障工具调用以失败结果回灌、不终止 Agent Loop。

## 功能需求

### 配置

- **F1**：`mcp_servers` 改为 map 声明，key 即 Server 名；每项支持 `type`（`stdio`｜`http`，默认 `stdio`）、`enabled`（默认 `true`）、`timeout`（毫秒，覆盖默认）。stdio 填 `command`、`args`、`env`；http 填 `url`、`headers`。
- **F2**：`env` 与 `headers` 的值支持 `${VAR}` 展开：先查该 Server 配置的 env 自身（可互相引用），再查进程环境变量；未定义展开为空串并产生一条警告。
- **F3**：Server 列表按用户级、项目级两层配置合并，同名单者项目级覆盖用户级；`enabled: false` 的 Server 完全跳过连接。

### 连接与协议

- **F4**：启动时对启用的 Server 并行执行三步会话——初始化握手（携带 MewCode 的协议版本与能力声明）、列出工具、建立就绪连接；stdio 走子进程 stdio 管道，http 走 Streamable HTTP（POST JSON-RPC，响应兼容普通 JSON 与 SSE 流）。
- **F5**：JSON-RPC 2.0 消息按 id 做异步配对；Server 主动发的通知（无 id）静默丢弃。
- **F6**：连接由管理器单例持有，Agent Loop 运行期间不拆连接，进程退出时统一清理（stdio kill 子进程，http 断开连接）。

### 工具接入

- **F7**：发现的每个远端工具包装为 MewCode 的 Tool 接口注册进 ToolRegistry：名称取工具原名，描述自动加 `[MCP: Server名]` 前缀下发，参数 schema 直接透传 Server 给的 JSON Schema；`readOnly` 一律为 false（按命令执行类处理）。
- **F8**：注册名冲突时自动加前缀为 `Server名_工具名`，无需用户干预。
- **F9**：每个 Server 连接设 10 秒握手超时（`timeout` 可覆盖）；超时或失败只降级——该 Server 工具不注册，其余照常。
- **F10**：工具调用超时 60 秒（`timeout` 可覆盖）；Server 断开后调用返回失败结果并提示「MCP Server 已断开」，不重连。

### 权限

- **F11**：MCP 工具走完整五层权限判定，与内置工具同一条路径；黑名单与路径沙箱两层对其不表态（结构化参数无从匹配命令串与路径），实际生效的是规则层、档位兜底、人在回路。
- **F12**：规则层支持 `Server名.工具名(模式)` 语法；模式匹配整个参数 JSON 文本，支持 `*` 通配。
- **F13**：未命中规则且档位要求确认时弹确认框，展示来源 Server 与调用摘要；三种放行粒度（本次/本会话/永久）照常可用，永久放行按 F12 语法写入本地配置。

### 执行与反馈

- **F14**：工具调用结果取 content 数组中 text 块按序拼接回灌，非 text 块记占位符说明；`isError:true` 与 JSON-RPC error 都转成失败结果回灌，不终止 Agent Loop。
- **F15**：MCP 工具出参与内置工具一样走统一的截断与脱敏；入参不设大小限制。
- **F16**：每个 Server 的连接结果（成功注册 N 个工具／失败原因／超时降级）以系统消息呈现在会话开场。

## 非功能需求

- **N1**：MCP 模块不依赖 TUI/React——连接、协议、适配全部是纯逻辑层，TUI 通过注册表间接消费。
- **N2**：新增依赖为零——协议与传输自研，只用 Node/Bun 标准库（`child_process`、`fetch` 等）。
- **N3**：Server 崩溃不产生僵尸子进程——进程退出路径必须清理 stdio 子进程；MewCode 崩溃或被 Ctrl+C 时同样不遗留子进程。
- **N4**：配置解析失败只降级到「该 Server 不连接」并出警告，不静默放开任何权限，不让 MewCode 启动失败。
- **N5**：协议版本兼容——握手失败的 Server（版本不匹配）按连接失败降级，给出明确的失败文案。
- **N6**：测试不依赖真实外部 Server——用测试桩（假子进程/假 HTTP）覆盖全部协议与生命周期场景。

## 不做的事

- MCP 的资源（resources）、提示词（prompts）、采样（sampling）等非工具能力
- Server 健康检查与自动重连
- 会话中途动态增删 Server（`/mcp` 管理命令）
- readOnly 配置标记（统一按写类处理，规则放行即可覆盖）
- 入参大小限制
- MCP 协议的 progress 通知展示、分页（pagination）细节

## 验收标准

- **AC1**（F1）：配置 map 中声明一个 stdio Server（command/args/env）与一个 http Server（url/headers），两者都被正确解析。
- **AC2**（F2）：`env` 值引用同 Server 内前置变量时取到该值；引用进程变量时取到进程值；引用未定义变量时展开为空串且出现警告。
- **AC3**（F3）：用户级与项目级声明同名 Server 时，连接配置取项目级的；项目级 `enabled: false` 时该 Server 不连接。
- **AC4**（F4）：启动后两个 Server（stdio+http）并行完成握手并列出工具，注册表里出现带 `[MCP: Server名]` 前缀描述的工具。
- **AC5**（F5）：Server 发出的通知消息不影响任何在途请求的 id 配对，也不出现在界面上。
- **AC6**（F6）：退出 MewCode 后，stdio Server 的子进程已终止（无残留进程）。
- **AC7**（F7/F8）：与内置工具重名的 MCP 工具注册为 `Server名_工具名`；Agent 可直接调用注册名。
- **AC8**（F9）：握手超过 timeout 的 Server 被跳过并出警告，其余 Server 正常连接，MewCode 正常进入聊天。
- **AC9**（F10）：调用已断开 Server 的工具时收到「MCP Server 已断开」的失败结果，本轮对话继续。
- **AC10**（F11）：默认档下调用 MCP 工具弹确认框；配置 `allow: Server名.工具名(*)` 后同调用不弹。
- **AC11**（F12）：`deny: Server名.工具名(模式)` 在放行档（bypass）下仍拒绝。
- **AC12**（F13）：确认框显示来源 Server；选「永久放行」后本地配置出现 `allow: Server名.工具名(...)` 规则，重启后不再询问。
- **AC13**（F14）：Server 返回多 text 块时按序拼接回灌；`isError:true` 转成失败结果后模型收到失败文案、本轮继续。
- **AC14**（F15）：超长 MCP 结果被截断并带截断标记，回灌内容与内置工具的截断行为一致。
- **AC15**（F16）：连接成功/失败/超时的 Server 各自有一条系统消息，内容可区分。
