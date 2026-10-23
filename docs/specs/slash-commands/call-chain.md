# 斜杠命令调用链：输入 `/` → 选中 → Enter

> 以「输入 `/s`，按 ↓ 选中 `/status`，再按 Enter」为例，按时间顺序列出每次按键经过的组件和函数。
> 文件路径相对 `typescript/src/`，行号对应当前代码，后续改动后可能偏移。

## 总览

```
键盘
 └─ Ink stdin 事件，同时分发给两个 useInput
     ├─ App 的 useInput（tui/app.tsx）只处理 Ctrl+C / Shift+Tab / Esc，Enter 不处理
     └─ InputBox 的 useInput（tui/input.tsx:71）
          └─ if (open) 分支 → Enter
               └─ onSubmit("/status")              // 就是 App.handleSubmit
                    └─ dispatch(...)               // commands/dispatcher.ts:15
                         ├─ parseInput              // commands/parser.ts:7
                         ├─ registry.resolve        // commands/registry.ts:43
                         ├─ 运行中检查 / 参数校验
                         └─ def.run({ args, ui, registry })
                              └─ ui.showMessage(formatStatus(ui.snapshot(), ui.getUsage()))
                                   └─ addNotice → setMessages  // tui/app.tsx:177
          └─ setLines([""]) 清空输入
 └─ React 批量重渲染：Static 输出新消息，输入框清空，列表消失
```

## 启动时的准备

| 位置 | 做什么 |
|---|---|
| `main.tsx:46` | `createCommandsOrExit()` 逐条 `register` 内置命令，建立「名称/别名 → 定义」索引；撞名直接以退出码 1 退出 |
| `main.tsx:88` | `<App commands={commands} … />` 把注册中心传进界面 |
| `tui/app.tsx:125` | `commandRegistry = commands ?? createBuiltinRegistry()`（测试不传时兜底） |
| `tui/app.tsx:127` | `suggestionsOpenRef = useRef(false)`，记录补全列表是否打开 |
| `tui/app.tsx:775-776` | 把 `suggest={(text) => suggest(text, commandRegistry)}` 和 `suggestionsOpenRef` 传给 `InputBox` |

## 第一步：输入 `/`，再输入 `s`

**组件**：`InputBox`（`tui/input.tsx`）

1. `useInput` 的普通字符分支把字符插入 `lines`，于是 `lines = ["/s"]`。
2. `lines` 变化触发重渲染，下面几行在每次渲染时都会重新计算：
   ```tsx
   const text  = lines.join("\n");                      // "/s"
   const items = suggest?.(text) ?? [];                 // 第 44 行
   const open  = items.length > 0 && !dismissed;        // true
   const current = highlight >= 0 ? … : Math.max(exact, 0); // 0，高亮 /session
   if (suggestionsOpenRef) suggestionsOpenRef.current = open; // 第 50 行，同步给 App
   ```
3. `suggest` 实际调用的是 `commands/completion.ts:8` 的 `suggest()`：
   ```ts
   if (!/^\/\S*$/.test(text)) return [];   // 单行、以 / 开头、还没出现空白才给候选
   const prefix = text.slice(1).toLowerCase();
   return registry.list(false)              // 排除隐藏命令，按主名字母序
     .filter((def) => [def.name, ...def.aliases].some((key) => key.toLowerCase().startsWith(prefix)))
     .map((def) => ({ name: def.name, description: def.description }));
   ```
   返回 `[{session}, {status}]`。
4. `useEffect(..., [lines])`（第 52 行）把 `highlight` 重置为 -1，`dismissed` 重置为 false。
5. 渲染结果（第 232 行）：
   ```
   ❯ /session  查看当前会话信息
     /status   查看 provider、档位、Token 与 MCP 状态
   ```

## 第二步：按 ↓

**组件**：`InputBox` 的 `useInput`，进入 `if (open)` 分支（第 74 行）

```tsx
if (key.downArrow) {
  setHighlight(Math.min(items.length - 1, current + 1));  // 0 → 1
  return;   // 不往下走，所以不会翻输入历史
}
```

重渲染后 `current = 1`，`❯` 移到 `/status` 前面。

## 第三步：按 Enter

### 3.1 InputBox 截获 Enter（`tui/input.tsx:89`）

```tsx
if (key.return && !key.shift && !key.ctrl) {
  if (!onSubmit(`/${items[current]!.name}`)) return;  // onSubmit("/status")
  setLines([""]);
  setHistoryIndex(null);
  setCursor({ line: 0, column: 0 });
  return;
}
```

提交的是高亮项的主名 `/status`，不是输入框里的原文 `/s`。

App 的 `useInput` 也会收到这次 Enter，但它只处理 Ctrl+C、Shift+Tab 和 Esc，所以什么都不做。

### 3.2 `App.handleSubmit`（`tui/app.tsx:722`）

```tsx
function handleSubmit(text: string): boolean {
  if (activityRef.current === "maintenance") return false;
  const busy = activityRef.current === "agent";
  const result = dispatch(text, { registry: commandRegistry, ui: commandUI, busy });
  if (result === "rejected") return false;      // 被拒：InputBox 不清空，保留输入
  if (result === "done") {
    setPromptHistory((previous) => [...previous, text]);  // 记入 ↑ 历史
    return true;                                 // InputBox 清空输入
  }
  …  // "not-command"：普通文本才会走到这里，交给 startAgentTurn
}
```

### 3.3 `dispatch`（`commands/dispatcher.ts:15`）

| 步骤 | 函数 | 结果 |
|---|---|---|
| 解析 | `parseInput("/status")`（`parser.ts:7`） | `{ type: "command", name: "status", args: "" }` |
| 查找 | `registry.resolve("status")`（`registry.ts:43`） | status 的定义对象（来自 `builtins/info.ts`） |
| 运行中检查 | `busy && !def.availableWhileBusy` | status 是 true，放行 |
| 参数校验 | `parsed.args && !def.argHint` | 没有参数，放行 |
| 按类型执行 | `def.kind` 是 `"local"`，走 run 分支（第 42 行） | `def.run({ args: "", ui: commandUI, registry })` |
| 返回 | 第 47 行 | `"done"` |

`run` 外面包了 `try/catch`；如果 `run` 返回 Promise，就挂上 `.catch(report)`（第 43 行）。所以命令出错时只会显示一条错误消息，不会把界面搞崩。

### 3.4 命令自己的 `run`（`commands/builtins/info.ts`）

```ts
run: ({ ui }) => ui.showMessage(formatStatus(ui.snapshot(), ui.getUsage()))
```

| 调用 | 实际落到 | 做什么 |
|---|---|---|
| `ui.snapshot()` | `commandUI.snapshot`（`tui/app.tsx:707`） | 从 App 的 ref 组装 provider（不含 `api_key`）、档位、规则、会话、记忆和 MCP 信息 |
| `ui.getUsage()` | `commandUI.getUsage`（`tui/app.tsx:691`） | 读取 Token state、上下文窗口和 Compactor 估算值 |
| `formatStatus(...)` | `commands/format.ts:45` | 纯函数，拼出多行文本，端点只保留主机名 |
| `ui.showMessage(text)` | `commandUI.showMessage`（`tui/app.tsx:688`）→ `addNotice`（`tui/app.tsx:177`） | `setMessages` 追加一条 `{ role: "system", content }`，同时 `advanceCommit` 把它标记为已定稿 |

### 3.5 回到 InputBox

`onSubmit` 返回 true，于是执行 `setLines([""])` 等清空操作。

## 第四步：React 批量重渲染

这次 Enter 排进队列的 state 更新有：`setMessages`、`setPromptHistory`、`setLines`、`setHistoryIndex`、`setCursor`。React 把它们合并成一次渲染：

| 组件 | 变化 |
|---|---|
| `App` → `<Static key={staticKey}>`（`tui/app.tsx:754`） | `committedIndexRef` 已经前移，新的系统消息进入静态区，经由 `CommittedMessage` → `MessageBlock`（`tui/chat.tsx`）用灰色文字输出 /status 的结果 |
| `InputBox` | `lines = [""]`，`suggest("")` 返回 `[]`，`open` 变成 false，列表消失，`suggestionsOpenRef.current` 也写成 false |
| `StatusBar`（`tui/app.tsx:778`） | 不变，因为没有发模型请求，Token 数不动 |

## 其他类型命令在 3.3 之后的走向

前面的步骤都一样，从 `dispatch` 按类型执行这一步开始分开：

| 选中的命令 | 进入的分支 | 后续调用 |
|---|---|---|
| `/plan`、`/do` 等 | run（ui 类） | `ui.setPermissionMode(m)` → `switchPermissionMode`（`tui/app.tsx:544`），同时更新 `permissionModeRef`、`mode` 和 `modeTracker`；`ui.refreshStatus()` → `setStatusTick`；重渲染后 `StatusBar` 显示 `MODE_INFO[permissionMode].label`，也就是 `[PLAN]` |
| `/clear` | run（ui 类） | `ui.clearConversation()` → `clearConversation`（`tui/app.tsx:666`）：清历史、调用 `startNewSession()`、写清屏序列、`setStaticKey(+1)` 让 Static 重新挂载 |
| `/compact` | run（ui 类，异步） | `ui.compact()` → `compactWithMaintenance`（`tui/app.tsx:642`）：设为 maintenance 状态，执行 `handleCompact()`，完成后复位 |
| `/resume` | run（ui 类） | `ui.openResume()` → `openResume`（`tui/app.tsx:652`）→ `setResumeList`，App 改为渲染 `SessionSelect`，取代 `InputBox` |
| `/review` | prompt 分支（第 34 行） | `ui.sendUserMessage(原命令, expandPrompt(...))` → `startAgentTurn(display, prompt)`（`tui/app.tsx:619`）→ 对话区显示原命令；`conversation.addUserMessage(prompt, display)` → `runAgentLoop(prompt)`，开始真正的模型请求 |
| Agent 运行中选了 `/clear` | 运行中检查不通过 | `showMessage("Agent 运行中…")`，返回 `"rejected"`；`handleSubmit` 返回 false，InputBox 不清空，列表仍然可见 |

## 补充：Esc 为什么不会误中断 Agent

Ink 把同一个按键同时分发给 App 和 InputBox 的 `useInput`。`suggestionsOpenRef` 在 InputBox 渲染时写入（`tui/input.tsx:50`），所以 App 的中断判断读到的总是按键之前的列表状态：

```tsx
// tui/app.tsx:281
if (key.escape && isStreaming && !suggestionsOpenRef.current) { …abort… }
```

列表开着时，Esc 只会让 InputBox 执行 `setDismissed(true)` 收起列表，不会中断正在运行的 Agent。

## 职责划分

| 角色 | 位置 | 职责 |
|---|---|---|
| 命令定义 | `commands/builtins/*` | 说明「做什么」，只依赖 `CommandUI` 接口，不知道 React/Ink 的存在 |
| 注册中心 | `commands/registry.ts` | 按名称或别名找到定义；补全与分发共用 |
| 分发器 | `commands/dispatcher.ts` | 串起解析、查找、运行中检查、参数校验、按类型执行和异常兜底 |
| 补全 | `commands/completion.ts` + `tui/input.tsx` | 前者算候选，后者管高亮、按键和渲染 |
| 界面控制实现 | `tui/app.tsx` 的 `commandUI` | 说明「怎么做」，把接口方法接到 React state、ref 和现有函数上；每次渲染重新构造，读到的是当前状态 |
