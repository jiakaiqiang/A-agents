# 意图联合识别模块 Plan

## 模块边界

本模块是一个纯输入输出单元:输入「当前用户输入 + 最近 3 轮历史」,
输出「识别目标结构体」。调用方如何使用识别目标不在本模块范围。
因此全部 AC 可在不跑通主对话链路的前提下验收。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/intent/types.ts` | 新建 | IntentTarget、SemanticCategory、RecognizerConfig 等类型 |
| `src/intent/prompt.ts` | 新建 | 识别提示词:四维输出约定 + 危险表述覆盖 |
| `src/intent/validate.ts` | 新建 | 结构校验器 + 未知工具名剔除 |
| `src/intent/recognizer.ts` | 新建 | 主入口 recognize():调用、超时、校验、降级 |
| `src/intent/index.ts` | 新建 | 对外只导出 recognize 与类型 |
| `src/config/config.ts` | 小改 | 加 recognizer 配置节 + 校验 + 密钥回退 |
| `tests/intent/*.test.ts` | 新建 | 校验器、降级、提示词覆盖、端到端桩 |

不改动:`src/agent/*`、`src/tui/*`、`src/llm/*`、`src/tools/*`、`src/conversation/*`。

识别侧自带 HTTP 调用,不接现有 LLM 层——现有层为流式对话设计,识别是非流式单次
请求,复用会引入不需要的流式事件与 provider 选择逻辑。

## 核心数据结构

```ts
// 语义类别(Q1 暂定六类)
type SemanticCategory =
  | "debug" | "feature" | "refactor"
  | "explain" | "ops" | "chat";

// 识别目标 —— 本模块唯一产出物,消费方接口
interface IntentTarget {
  semantic: SemanticCategory;
  allowedTools: string[];      // 上界,非调用序列
  contextHints: string[];      // 路径模式,提示性
  dangerous: boolean;
  dangerReason: string;        // dangerous 为 false 时为空串
  elapsedMs: number;
  degraded: boolean;
  degradeReason: string;       // degraded 为 false 时为空串
}

// 识别模型配置(config.yaml 新增节)
interface RecognizerConfig {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key?: string;            // 缺失时回退 MEWCODE_RECOGNIZER_API_KEY
  timeout_ms: number;          // Q2 暂定 1500
}

// 主入口
function recognize(
  input: string,
  recentHistory: Message[],    // 最近 3 轮
  cfg: RecognizerConfig,
  knownTools: string[],        // 用于剔除未知工具名
  signal?: AbortSignal,
): Promise<IntentTarget>;
```

## 处理链路

```text
recognize()
  ├ cfg.enabled === false → 返回降级目标(degradeReason: "已关闭")
  ├ 构造 prompt(input + 最近 3 轮 + 四维输出约定)
  ├ fetch(base_url, { signal: 合并了 timeout 的 signal })
  │    ├ 超时/不可达/401 → 降级目标
  │    └ 200 → 文本
  ├ JSON.parse → 失败则降级
  ├ validate(raw, knownTools)
  │    ├ 字段缺失/类型错/语义类别非法 → 降级
  │    ├ 剔除未知工具名 → 剩余为空则降级
  │    └ dangerous 为真但 reason 空 → 补默认文案(不判无效)
  └ 返回 IntentTarget(填 elapsedMs)
```

降级目标恒定形状:

```ts
{
  semantic: "chat",
  allowedTools: READ_ONLY_TOOLS,   // 只读子集
  contextHints: [],
  dangerous: true,                 // A8:保守侧
  dangerReason: "识别不可用,按危险处理",
  degraded: true,
  degradeReason: <具体原因>,
}
```

## 提示词要点(prompt.ts)

- 要求严格输出 JSON,不带 markdown 围栏、不带解释文字。
- 四维输出约定逐项说明,给出字段名与取值范围。
- 危险判定分两类明确列举:
  - 显式:删除、清空、覆盖、重置、drop、truncate、rm -rf、格式化
  - 等价温和:清理一下、不要了、重来、恢复初始、腾出空间、只保留…
- 明确"不确定时 dangerous 取 true"。
- 明确工具名只能取自给定清单。

## 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 是否复用现有 LLM 层 | 不复用,自带 fetch | 识别为非流式单次请求;现有层的流式事件、provider 选择、上下文窗口探测全不需要 |
| 超时实现 | AbortSignal + setTimeout,与外部 signal 合并 | 外部中断与超时共用一条取消路径 |
| 降级时 dangerous | 取 true | 错的方向要安全;取 false 会让识别故障时危险操作静默通过 |
| 降级时 semantic | 固定 "chat" | 无信息时不猜类别;调用方看 degraded 字段判断可信度 |
| 未知工具名 | 剔除而非整体判无效 | 小模型偶尔编造工具名,剔除后仍可用;全空才降级 |
| dangerReason 为空 | 补默认文案 | 标记比原因重要,不因文案缺失丢掉标记 |
| 校验器与调用分离 | validate.ts 独立 | 全部结构分支可纯函数测试,不需要桩端点 |
| 语义类别 | 硬编码枚举 | Q1 未定,先不进配置层 |
