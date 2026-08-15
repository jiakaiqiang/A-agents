# 多协议 LLM 终端对话客户端 Checklist 验收记录

> 本次开发使用 `bun run typecheck`、`bun test` 和真实 OpenAI-compatible endpoint smoke test 验证。
> tmux 不可用：当前 Windows 环境未安装 tmux，WSL 仅有 docker-desktop 且没有 bash/tmux。

## 已验证
- [x] 配置类型、三层路径加载、provider 校验和 API key 回退已实现（验证：`tests/config.test.ts`）。
- [x] ConversationManager 支持 user/assistant 顺序、返回副本、长度和截断（验证：`tests/conversation.test.ts`）。
- [x] TypeScript 编译通过（证据：`bun run typecheck`，`tsc --noEmit` 退出码 0）。
- [x] 单元测试通过（证据：`bun test`，7 pass / 0 fail）。
- [x] 真实配置可加载且未打印密钥（验证：脱敏配置摘要输出）。
- [x] OpenAI Responses/兼容客户端能建立流式请求并正常结束（证据：真实 smoke test 退出码 0，stopReason 为 `end_turn`）。
- [x] TUI 启动横幅、模型、工作目录、输入框、状态栏可渲染（证据：`bun run src/main.tsx` 输出）。

## 未完成或受环境限制
- [ ] tmux 端到端测试：环境没有可用 tmux/WSL shell，无法执行项目要求的 tmux 验收。
- [ ] 真实文本增量：当前兼容端点返回了空流结束事件，未能验证正文增量；需使用会返回 `response.output_text.delta` 或 Chat Completion `delta.content` 的端点。
- [ ] 交互式 Ink 输入：非 TTY 管道运行会触发 Ink 的 raw mode 限制，需在真实终端或 tmux 中验证。
- [ ] Anthropic 与 OpenAI 两个真实协议各自的在线收发：当前环境仅有一个 OpenAI-compatible 配置，未使用或修改密钥配置。

## 端到端场景状态
- [ ] Anthropic 多轮 + thinking：未执行，缺少可安全使用的 Anthropic 运行配置。
- [ ] OpenAI Responses 流式：已执行请求建立 smoke test，但兼容端点无正文增量。
- [ ] OpenAI-compatible：已执行，客户端无异常退出。
- [ ] 多 provider 选择：组件已实现，未在真实交互终端验证方向键。
- [ ] 错误恢复：错误分类和 TUI 展示已实现，未对真实错误密钥做在线破坏性测试。
