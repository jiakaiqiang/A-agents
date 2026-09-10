# 权限系统 Plan

## 架构概览

权限系统落成一个新目录 `src/permission/`，对外只暴露一个判定入口与一个规则加载入口。`runTool` 在参数校验通过后调用判定，拒绝则直接返回工具失败结果，工具的 `execute` 不会被调用（F1、N1）。

六个组件：

- **常量与类型层**：黑名单正则集合、四档档位名、工具分类归属，集中声明（N8）。
- **黑名单**：只认 Bash 命令文本，命中返回拒绝，否则不表态（F4、F5）。
- **路径守卫**：文件类工具从已校验参数里取路径、Bash 从命令文本里抽路径片段，统一交给现有的 `resolveInside` 判定（F6–F8）。
- **规则引擎**：把 `工具名(模式)` 解析成可匹配的规则，按四层来源逐层查，层内取最后命中（F9–F13）。
- **档位兜底**：规则未命中时按当前档位与工具分类给出放行、确认、拒绝（F14–F17）。
- **询问桥**：把「需要确认」这个判定结果转成一次异步用户询问，Promise 从判定层一直挂到 TUI 按键（F20–F25）。

判定层不 import 任何 TUI 模块。确认能力以回调形式经 `ToolContext` 注入，回调缺失时按拒绝处理，保证非交互环境（测试、未来的非 TUI 入口）不会挂死。

## 判定流水线

```
runTool（参数校验后）
    │
    ▼
decide(tool, args, ctx)
    │
    ├─ 1 黑名单 ────────── deny → 返回拒绝（不可放开）
    │                      不表态 ↓
    ├─ 2 路径守卫 ───────── deny → 返回拒绝（不可放开）
    │                      不表态 ↓
    ├─ 3 规则引擎 ───────── allow → 返回放行
    │                      deny  → 返回拒绝
    │                      未命中 ↓
    ├─ 4 档位兜底 ───────── allow → 返回放行
    │                      deny  → 返回拒绝
    │                      ask   ↓
    └─ 5 询问桥 ─────────── 用户选择 → 放行 / 拒绝
                              （放行范围登记到会话规则或本地配置）
```

前两层只有「拒绝」与「不表态」两种输出，永远不产出放行，因此黑名单与沙箱不可能成为跳过后续检查的通道（spec F2、N2）。后三层可以放行。

## 核心数据结构

### PermissionMode

```ts
export type PermissionMode = "plan" | "default" | "acceptEdits" | "bypass";
```

四档取值。与现有的 `AgentMode`（`"execute" | "plan"`）是两个不同概念：`AgentMode` 描述提示词层的任务模式，`PermissionMode` 描述准入档位。二者的映射见「与现有模式的关系」。

### ToolClass

```ts
export type ToolClass = "read" | "write" | "bash";
```

档位兜底表的行维度。分类由工具名归属，集中声明；`readOnly === true` 的工具归 `read`，`Write`/`Edit` 归 `write`，`Bash` 归 `bash`。

### PermissionDecision

```ts
export type PermissionDecision =
  | { verdict: "allow"; layer: DecisionLayer }
  | { verdict: "deny"; layer: DecisionLayer; reason: string };
```

判定层对外只有这两种终态（spec F1）。`ask` 不出现在这里——它是档位兜底的内部输出，在流水线内被询问桥消解掉。

```ts
export type DecisionLayer = "blacklist" | "sandbox" | "rule" | "mode" | "human";
```

`layer` 决定回给模型的文案前缀，四种拒绝彼此可区分（N4、AC25）。

### LayerVerdict

```ts
export type LayerVerdict = "allow" | "deny" | "ask" | "abstain";
```

单层的输出。黑名单与路径守卫只会返回 `deny` 或 `abstain`；规则引擎返回 `allow`/`deny`/`abstain`；档位兜底返回 `allow`/`deny`/`ask`，不返回 `abstain`（它是兜底层，必须表态）。

### Rule

```ts
export interface Rule {
  tool: string;      // 工具名，如 "Bash"
  pattern: string;   // 括号内的模式原文，如 "git *"
  effect: "allow" | "deny";
  source: RuleSource;
  order: number;     // 同层内的书写序号，越大越晚写
}

export type RuleSource = "session" | "local" | "project" | "user";
```

`order` 支撑 F13「同层靠后的赢」。四层优先级 `session > local > project > user`（F12）。

### RuleSet

```ts
export interface RuleSet {
  layers: Record<RuleSource, Rule[]>;  // 每层内部按 order 升序
}
```

按来源分桶存放。匹配时按 `session → local → project → user` 顺序取第一个有命中的层，在该层内取 `order` 最大的命中项。

### ConfirmRequest / ConfirmChoice

```ts
export interface ConfirmRequest {
  toolName: string;
  summary: string;        // 复用 tool.callSummary(args)
  ruleCandidate: string;  // 永久放行会写入的规则文本，如 "Bash(npm test)"
}

export type ConfirmChoice = "once" | "session" | "always" | "deny";
```

`ruleCandidate` 在弹框时就算好，既用于界面展示「永久放行将记录什么」，也用于用户选 `session`/`always` 时直接落库，避免两处各算一遍导致不一致。

### ToolContext 扩展

```ts
export interface ToolContext {
  workDir: string;
  signal?: AbortSignal;
  permission?: PermissionGate;   // 新增，缺失时判定退化为「需要确认即拒绝」
}

export interface PermissionGate {
  mode: PermissionMode;
  rules: RuleSet;
  confirm?(request: ConfirmRequest): Promise<ConfirmChoice>;
  grantSession(rule: Rule): void;
  grantAlways(rule: Rule): void;
}
```

判定所需的一切经 `ToolContext` 传入，`decide` 本身无状态、无全局单例，测试可直接构造。`confirm` 是可选的：非交互环境不提供，届时需要确认的调用一律拒绝并在原因里说明「当前环境无法交互确认」。

## 模块设计

### src/permission/limits.ts

**职责**：集中声明黑名单正则集合、四档档位名列表、工具分类映射（N8、AC27）。

**对外接口**：
```ts
export const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }>;
export const PERMISSION_MODES: PermissionMode[];
export const MODE_FALLBACK: Record<PermissionMode, Record<ToolClass, "allow" | "ask">>;
export function classifyTool(tool: Tool): ToolClass;
```

`MODE_FALLBACK` 就是 spec F14 那张表的数据化形式，档位兜底层只做一次查表，不写 if 分支。表里只有 `allow` 与 `ask` 两种取值——四档中没有任何一档的兜底是直接拒绝（这是需求确认时定下的：严格档被改成了计划档，兜底是确认而非拒绝）。

`DANGEROUS_PATTERNS` 每条带 `label`，用于拒绝文案说明命中了哪一类高危操作。

**依赖**：`../tools/types.js`（取 `Tool`）。

**说明**：项目现有惯例把上限常量放 `src/tools/limits.ts`。权限相关常量另立文件而不塞进去，因为它们不是资源上限，且黑名单正则会有一定体量；`src/tools/limits.ts` 保持原状不动。

### src/permission/blacklist.ts

**职责**：第一层。匹配 Bash 命令文本。

**对外接口**：
```ts
export function checkBlacklist(toolName: string, args: Record<string, unknown>): LayerResult;
```

非 Bash 工具直接 `abstain`。Bash 取 `command` 参数，逐条正则匹配，命中即 `deny` 并带上 `label`。

**依赖**：`./limits.js`、`./types.js`。

### src/permission/sandbox.ts

**职责**：第二层。文件类工具的路径参数与 Bash 命令文本里的路径片段都限制在工作目录内。

**对外接口**：
```ts
export function checkSandbox(tool: Tool, args: Record<string, unknown>, workDir: string): LayerResult;
export function extractPathCandidates(command: string): string[];
```

文件类工具从已校验参数里按工具取路径字段（Read/Write/Edit 取 `file_path`，Glob/Grep 取可选的 `path`），交给现有 `resolveInside` 判定。

Bash 走 `extractPathCandidates`：从命令字符串里识别两类片段——以 `/` 或盘符开头的绝对路径、含 `..` 段的相对路径——逐个过 `resolveInside`，任一越界即拒绝整条命令（F7）。只做文本识别，不展开变量、不求值、不模拟 shell 解析。已知会误报（`grep -r ".." .`），这是 spec 已接受的取舍。

**依赖**：`../tools/paths.js`（复用 `resolveInside`，不改动它）、`./types.js`。

**说明**：文件类工具自身的 `execute` 里已经各自调用了 `resolveInside`。这里再判一次是有意的重复：F8 要求沙箱作为不可放开的独立层存在，不能依赖各工具自觉。重复判定成本是一次路径解析，可以接受。

### src/permission/rules.ts

**职责**：第三层。规则文本解析、匹配、四层查找。

**对外接口**：
```ts
export function parseRule(text: string, effect: "allow" | "deny", source: RuleSource, order: number): Rule | undefined;
export function matchRule(rule: Rule, toolName: string, args: Record<string, unknown>): boolean;
export function checkRules(rules: RuleSet, toolName: string, args: Record<string, unknown>): LayerResult;
export function ruleTextFor(tool: Tool, args: Record<string, unknown>): string;
```

`parseRule` 解析 `工具名(模式)`：截取首个 `(` 与末个 `)` 之间的内容作为模式，允许模式内含括号。格式非法返回 `undefined`，由加载层收集为警告（N5）。

`matchRule` 的匹配对象按工具定：Bash 匹配整条 `command` 字符串（F10，不拆 `&&`/`|`/`;`）；文件类工具匹配路径参数的 POSIX 相对路径形式。模式不含 `*` 时做全等比较，含 `*` 时转成 glob 正则比较（F9）。

`checkRules` 按 `session → local → project → user` 逐层扫，第一个有命中的层内取 `order` 最大的命中规则的 `effect`；四层都无命中返回 `abstain`。

`ruleTextFor` 生成永久放行要写入的规则文本，精确整串、不泛化（F23）。

**依赖**：`./types.js`、`../tools/paths.js`（路径归一化）。

### src/permission/config.ts

**职责**：从三层 YAML 读规则、解析启动档位、写入永久放行。

**对外接口**：
```ts
export interface PermissionConfigResult {
  mode: PermissionMode;
  rules: RuleSet;
  warnings: string[];
}
export function loadPermissionConfig(cwd?: string): PermissionConfigResult;
export function appendLocalRule(rule: Rule, cwd?: string): void;
```

**YAML 结构（新增）**：F13 要求同层保序，因此规则存成一个有序列表，每项一个单键对象：

```yaml
permission_mode: default
permissions:
  - deny: Bash(git push*)
  - allow: Bash(git *)
```

列表顺序即 `order`。这与「allow 和 deny 两个独立键」的写法不兼容——后者无法表达先后，是需求确认时明确接受的结构变更。

三个文件路径沿用配置系统现有的那三个（用户级 `~/.mewcode/config.yaml`、项目级 `.mewcode/config.yaml`、项目本地级 `.mewcode/config.local.yaml`），但**不复用 `mergeConfig`**：合并会丢掉来源信息，而 F12 的分层优先级必须知道每条规则来自哪一层。所以这里各文件单独读、各自分桶。

`mode` 取自 `permission_mode` 字段，缺失取 `"default"`，值非法取 `"default"` 并产出一条 warning（F17、N5）。规则文本解析失败同样进 warnings，不静默放开。

`appendLocalRule` 追加写项目本地级文件：读原文件（不存在则视为空）、在 `permissions` 列表尾部追加、整体写回。追加到尾部同时满足 F13——新写的规则在本层顺序最后，优先级最高。

**依赖**：`js-yaml`、`node:fs`、`./rules.js`。

**说明**：`src/config/config.ts` 的 `AppConfig.permission_mode` 字段已存在且已参与 `mergeConfig`，但本模块不通过它取值——`mergeConfig` 后拿不到来源分层，规则必须自己读。`AppConfig` 保持不动，`permission_mode` 字段仍留在那里（它的合并语义与本模块的取值结果一致，不会冲突）。

### src/permission/decide.ts

**职责**：串起五层，产出唯一终态。

**对外接口**：
```ts
export async function decide(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PermissionDecision>;
```

按流水线顺序调四个 check，任一层 `deny` 即返回、`allow` 即返回。走到 `ask` 时调 `context.permission.confirm`：

- `once` → 放行，不登记
- `session` → `grantSession(rule)` 后放行
- `always` → `grantAlways(rule)` 后放行
- `deny` → 拒绝，原因用固定文案（F24）

`confirm` 缺失或抛错时按拒绝处理，原因说明无法交互。`context.permission` 整体缺失时，走完前四层，`ask` 直接转拒绝——这让所有现有测试在不改造的情况下仍能跑通读类工具。

**依赖**：本目录其余模块、`../tools/types.js`。

### 现有文件改动

**`src/tools/types.ts`**：`ToolErrorKind` 增加 `"permission_denied"`；`ToolContext` 增加可选 `permission` 字段。新增错误分类而不复用 `out_of_scope`，是为了让 AC25 的四种拒绝可区分，也让测试能精确断言。

**`src/tools/execute.ts`**：`runTool` 在 `validate` 之后、`tool.execute` 之前插入判定，拒绝时 `return fail("permission_denied", decision.reason)`。这是唯一插入点，`runOne` → `runTool` 是所有工具调用的必经路径（F1）。

**`src/agent/loop.ts`**：`LoopOptions` 增加 `permission?: PermissionGate`，原样透传进 `runBatches` 的 context。`registry.definitionsFor` 的 `readOnlyOnly` 参数改为恒 `false`（F19：计划档下写类工具照常下发）。`StopReason` 不新增取值（F3、AC3）。

**`src/agent/batch.ts`**：不改。`planBatches` 按 `readOnly` 分批的现有逻辑已满足 F25——Write/Edit/Bash 都是 `readOnly: false`，各自单独成串行批；并发批只含读类，而读类在四档下兜底全是 `allow`，永不触发确认。

**`src/prompt/sections.ts`**：`taskModeSection` 的措辞要改。现在写的是「计划模式：只有只读工具可用」，与 F19 矛盾，改为说明计划模式下改文件需要用户逐次确认。

**`src/prompt/reminder.ts`**：`PLAN_FULL`/`PLAN_BRIEF` 保留（F18），措辞微调，去掉暗示工具不可用的表述。

**`src/tui/app.tsx`**：
- 新增 `permissionMode` state 与 `pendingConfirm` state。
- `handleSubmit` 增加 `/accept-edits`、`/bypass` 两个分支；`/plan`、`/do` 改为同时切 `AgentMode` 与 `PermissionMode`。
- 新增 `confirm` 实现：创建一个 Promise，把 resolve 存进 ref，设置 `pendingConfirm` 触发确认框渲染；用户按键后取出 resolve 调用并清空 state。
- 组装 `PermissionGate` 传给 `runLoop`：`grantSession` 写入 `sessionRulesRef`，`grantAlways` 调 `appendLocalRule` 后同样写入 `sessionRulesRef`（本进程立即生效，不重读文件）。
- 启动时调 `loadPermissionConfig`，warnings 以 system 消息呈现（N5）。

**`src/tui/confirm.tsx`（新建）**：确认框组件。四个选项的键盘选择，参照 `provider-select.tsx` 的写法（↑/↓ + Enter）。

**`src/tui/status-bar.tsx`**：展示当前权限档位。

## 模块交互

一次需要确认的 Bash 调用的完整链路：

```
用户输入
  → app.tsx handleSubmit
  → runAgentLoop → runLoop（permission 随 LoopOptions 传入）
  → planBatches（Bash 单独成串行批）
  → runBatches（context 含 permission）
  → runOne → runTool
  → decide
      → checkBlacklist   abstain
      → checkSandbox     abstain
      → checkRules       abstain
      → 档位兜底查表      ask
      → context.permission.confirm(request)  ← Promise 在此挂起
                │
                ▼
        app.tsx 的 confirm 实现
          setPendingConfirm(request) + 存 resolve
                │
                ▼
        ConfirmBox 渲染，InputBox 让位，独占键盘
                │
                ▼
        用户按 Enter → resolve(choice)
                │
                ▼
      decide 恢复：登记规则（若需要）→ 返回 allow
  → tool.execute 真正执行
  → 结果沿原路回到 runLoop → 写入会话 → 界面
```

关键点：确认期间整个 `runLoop` 的 `for await` 停在 `runBatches` 上，不消费新事件。这正是「只走串行路径」的前提——串行批一次只有一个调用在跑，挂起不会造成多个确认框争抢键盘（D7）。

键盘归属：`app.tsx:87` 的 `useInput` 现在处理 Esc 中断。`pendingConfirm` 非空时，`ConfirmBox` 自己的 `useInput` 接管方向键与 Enter；Esc 仍走顶层，中断时需要 resolve 掉挂起的 Promise 为 `"deny"`，避免 Promise 永远悬空。

## 与现有模式的关系

`AgentMode` 与 `PermissionMode` 是两个正交概念，都保留：

| 用户命令 | AgentMode | PermissionMode | 效果 |
|---|---|---|---|
| `/plan` | `plan` | `plan` | 提示词含计划模式提醒；写类与 Bash 逐次确认 |
| `/do` | `execute` | `default` | 无计划提醒；写类与 Bash 逐次确认 |
| `/accept-edits` | `execute` | `acceptEdits` | 无计划提醒；写类自动放行，Bash 确认 |
| `/bypass` | `execute` | `bypass` | 无计划提醒；全部放行（黑名单与沙箱仍拦） |

`AgentMode` 从此只决定提示词注入（`ModeTracker`），不再决定工具下发范围。`registry.definitionsFor` 的 `readOnlyOnly` 选项本身保留在 `ToolRegistry` 上不删（它是 registry 的通用能力），只是 `loop.ts` 不再传 `true`。

## 文件组织

```
typescript/src/
├── permission/                 ← 新建目录
│   ├── types.ts                — PermissionMode、ToolClass、Rule、RuleSet、
│   │                             PermissionDecision、LayerVerdict、LayerResult、
│   │                             ConfirmRequest、ConfirmChoice、PermissionGate
│   ├── limits.ts               — DANGEROUS_PATTERNS、PERMISSION_MODES、
│   │                             MODE_FALLBACK、classifyTool
│   ├── blacklist.ts            — checkBlacklist
│   ├── sandbox.ts              — checkSandbox、extractPathCandidates
│   ├── rules.ts                — parseRule、matchRule、checkRules、ruleTextFor
│   ├── config.ts               — loadPermissionConfig、appendLocalRule
│   └── decide.ts               — decide（五层串联）
├── tools/
│   ├── types.ts                — 改：ToolErrorKind 加一项、ToolContext 加 permission
│   ├── execute.ts              — 改：runTool 插入判定
│   └── paths.ts                — 不改，被 sandbox.ts 复用
├── agent/
│   ├── loop.ts                 — 改：LoopOptions 加 permission、取消只读过滤
│   └── batch.ts                — 不改
├── prompt/
│   ├── sections.ts             — 改：taskModeSection 措辞
│   └── reminder.ts             — 改：计划模式提醒措辞
└── tui/
    ├── app.tsx                 — 改：档位 state、两个新命令、confirm 实现、Gate 组装
    ├── confirm.tsx             — 新建：确认框组件
    └── status-bar.tsx          — 改：展示当前档位

typescript/tests/
└── permission/                 ← 新建目录
    ├── blacklist.test.ts
    ├── sandbox.test.ts
    ├── rules.test.ts
    ├── config.test.ts
    └── decide.test.ts
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| P1 判定插入位置 | `runTool` 内，参数校验后 | 所有工具调用的唯一必经路径；放在校验后能拿到归一化参数，路径与命令都已是确定值 |
| P2 判定层与 UI 的关系 | 经 `ToolContext` 注入 `confirm` 回调，判定层不 import TUI | 保持权限模块可单测；非交互环境（测试、未来的非 TUI 入口）不会挂死 |
| P3 前两层的输出形态 | 只能 `deny` 或 `abstain`，不能 `allow` | 结构上保证黑名单与沙箱不可被放开，也不会成为跳过后续层的通道（N2） |
| P4 沙箱重复判定 | 权限层判一次，工具 `execute` 内保留原有判定 | F8 要求沙箱是独立不可放开的层，不能依赖各工具自觉；成本仅一次路径解析 |
| P5 规则不复用 `mergeConfig` | 各层文件单独读、按来源分桶 | `mergeConfig` 会丢来源信息，而 F12 的分层优先级必须知道规则出自哪层 |
| P6 YAML 规则结构 | 有序列表，每项单键对象 | F13「同层靠后的赢」要求保序；`allow:`/`deny:` 两个键无法表达先后 |
| P7 新增错误分类 | `ToolErrorKind` 加 `permission_denied` | 让 AC25 的四种拒绝可区分，测试可精确断言，不与既有 `out_of_scope` 混淆 |
| P8 档位与 AgentMode 并存 | 两个概念都保留，一条命令同时切两者 | 提示词模式与准入档位正交；合并会挤掉其中一个语义（spec D4） |
| P9 权限常量单独立文件 | `src/permission/limits.ts`，不塞进 `src/tools/limits.ts` | 后者是资源上限专用；黑名单正则有体量，混放会削弱其「上限集中声明」的定位 |
| P10 会话规则存放 | `app.tsx` 的 ref，进程内存 | F22 要求进程退出即失效；ref 与现有 `conversationRef`、`modeTrackerRef` 的做法一致 |
| P11 永久放行写入后的即时生效 | 写文件的同时也写入会话层 | 避免重读配置文件；两处内容一致，本进程立即生效 |
| P12 中断时的挂起 Promise | Esc 中断时 resolve 为 `"deny"` | 不 resolve 会让 Promise 永久悬空，`runLoop` 无法收尾 |
