# 意图联合识别模块 Tasks

## 全局约束(每个任务都适用)

- 不新增第三方依赖(HTTP 用运行时内置 fetch)。
- 注释用中文,风格匹配现有文件。
- 只改 plan.md「改动范围」表里的文件。
- 每个任务完成后跑该任务的验证命令,贴真实输出,然后停下等我确认,
  不要连着做下一个任务。

---

## T1: 类型与降级目标常量

**文件:** `src/intent/types.ts`

**依赖:** 无

**步骤:**
1. 定义 `SemanticCategory` 联合类型(六个字面量:`debug` / `feature` /
   `refactor` / `explain` / `ops` / `chat`)与 `SEMANTIC_CATEGORIES` 数组常量
   (供校验器判合法性)。
2. 定义 `IntentTarget` 接口(八个字段,照 plan.md)。
3. 定义 `RecognizerConfig` 接口。
4. 定义 `READ_ONLY_TOOLS` 常量数组,值为只读工具名。
5. 导出 `makeDegraded(reason: string): IntentTarget` 工厂,返回 plan.md 里的
   恒定降级形状。

**验证:** `bun run typecheck` 退出码 0。

**禁止:** 本任务不写任何请求逻辑、不改 config。

---

## T2: 结构校验器

**文件:** `src/intent/validate.ts`

**依赖:** T1

**步骤:**
1. 实现 `validate(raw: unknown, knownTools: string[]): IntentTarget | null`,
   返回 null 表示无效(由调用方转降级)。
2. 逐项校验:五个字段存在;`semantic` 在 `SEMANTIC_CATEGORIES` 内;
   `allowedTools` 为字符串数组;`contextHints` 为字符串数组;
   `dangerous` 为布尔。
3. 剔除 `allowedTools` 中不在 `knownTools` 的项;剔除后为空返回 null。
4. `dangerous === true` 且 `dangerReason` 为空/非字符串时,补默认文案
   "识别到危险操作意图",不返回 null。
5. `dangerous === false` 时强制 `dangerReason` 为空串。
6. `elapsedMs` / `degraded` / `degradeReason` 由调用方填,本函数填
   `0` / `false` / `""`。

**验证:** `bun run typecheck` 退出码 0。

**禁止:** 不在这里发请求、不在这里构造降级目标(用 T1 的 `makeDegraded`)。

---

## T3: 校验器单测

**文件:** `tests/intent/validate.test.ts`

**依赖:** T2

**步骤:**
1. 合法输入 → 返回非 null,字段透传正确。
2. 缺 `semantic` / `semantic` 非法值 / `allowedTools` 非数组 /
   `dangerous` 非布尔四个用例 → 各返回 null。
3. `allowedTools` 含未注册名 → 剔除后保留其余;全部未注册 → 返回 null。
4. `dangerous: true` 且 reason 空 → 返回非 null 且 reason 为默认文案。
5. `dangerous: false` 且 reason 有值 → reason 被清空。

**验证:** `bun test tests/intent/validate.test.ts` 全绿。

**禁止:** 不放宽 T2 的校验规则来让测试变绿。

---

## T4: 识别提示词

**文件:** `src/intent/prompt.ts`

**依赖:** T1

**步骤:**
1. 实现 `buildRecognizePrompt(input: string, recentHistory: Message[],
   knownTools: string[]): string`。
2. 提示词包含:严格 JSON 输出要求(无围栏无解释)、四个字段的名称与取值范围、
   工具名只能取自 `knownTools`。
3. 危险判定分两类逐条列举(照 plan.md 的清单),并写明"不确定时 dangerous
   取 true"。
4. 历史只取最近 3 轮,超出截断;单条超长按字符数截断。

**验证:** `bun run typecheck` 退出码 0;临时打印一次提示词,肉眼确认含两类
危险清单与全部工具名。

**禁止:** 不在提示词里写死具体项目路径或文件名。

---

## T5: 主入口 recognize

**文件:** `src/intent/recognizer.ts`、`src/intent/index.ts`

**依赖:** T2、T4

**步骤:**
1. 实现 `recognize(...)`,链路照 plan.md:关闭 → 构造 prompt → fetch →
   parse → validate → 填 `elapsedMs` 返回。
2. `cfg.enabled === false` 时不发请求,直接 `makeDegraded("已关闭")`。
3. 超时:`AbortSignal.timeout(cfg.timeout_ms)` 与外部 signal 合并
   (`AbortSignal.any`);超时降级,reason "识别超时"。
4. 非 2xx:401 降级 reason "识别鉴权失败",其余 "识别不可用";
   fetch 抛错同样降级为 "识别不可用"。
5. `JSON.parse` 失败或 `validate` 返回 null → 降级 reason "识别结果无效"。
6. 全程 `elapsedMs` 用 `Date.now()` 差值填入,降级目标也要填。
7. 外部 signal 触发的中断:抛出 AbortError,不返回降级目标(由调用方处理)。
8. `index.ts` 只导出 `recognize` 与类型,不导出内部函数。

**验证:** `bun run typecheck` 退出码 0。

**禁止:** 不重试;不改 `src/llm/*`;不引入第三方 HTTP 库。

---

## T6: 配置节

**文件:** `src/config/config.ts`

**依赖:** T1

**步骤:**
1. `AppConfig` 增加可选 `recognizer?: RecognizerConfig`。
2. `loadSingleFile` 读取 `recognizer` 键;缺失时不报错(视为未配置)。
3. `mergeConfig`:override 的 `recognizer` 非空时整节覆盖。
4. 新增 `validateRecognizer`:节存在且 `enabled !== false` 时,校验
   `base_url` / `model` 必填,`timeout_ms` 缺失填默认 1500 且须为正数;
   非法时抛 `ConfigError`,消息含字段名。
5. 新增 `resolveRecognizerAPIKey(cfg)`:优先 `api_key`,回退
   `process.env.MEWCODE_RECOGNIZER_API_KEY`,都缺返回空串。

**验证:** `bun run typecheck` 退出码 0;既有 `bun test` 全部仍通过
(配置节为可选,不应影响现有用例)。

**禁止:** 不改现有 providers 的校验逻辑;不把识别配置混进 providers 数组。

---

## T7: 降级与端到端桩测试

**文件:** `tests/intent/recognizer.test.ts`

**依赖:** T5、T6

**步骤:**
1. 用可替换的 fetch 桩(注入或 monkey-patch `globalThis.fetch`,
   `afterEach` 还原)。
2. 六个降级用例:enabled false、端点不可达(抛错)、超时(桩延迟 2000ms 且
   timeout 设 100ms)、401、非 JSON、结构不符 → 各断言 `degraded === true`、
   `dangerous === true`、`allowedTools` 等于只读子集、`degradeReason` 正确。
3. 正常用例:桩返回合法 JSON → 断言八字段正确、`degraded === false`、
   `elapsedMs > 0`。
4. 未知工具名用例:桩返回含编造工具名 → 断言被剔除、其余保留、不降级。
5. 外部中断用例:传入已 abort 的 signal → 断言抛出 AbortError 而非返回
   降级目标。

**验证:** `bun test tests/intent/` 全绿。

**禁止:** 不放宽断言;桩 fetch 必须在 `afterEach` 还原,不得泄漏到其他
测试文件。

---

## T8: 危险捕获样本测试

**文件:** `tests/intent/danger.test.ts`

**依赖:** T4

**步骤:**
1. 本任务只测提示词内容,不调真实模型:断言 `buildRecognizePrompt` 的输出
   同时包含显式危险词清单与温和表述清单的关键条目,以及"不确定时取 true"字样。
2. 把 AC3 / AC4 / AC5 的三组样本写成常量数组导出(供后续真实端点手工验收
   使用),并断言数组各自非空、三组无重复条目。

**验证:** `bun test tests/intent/danger.test.ts` 全绿。

**禁止:** 本任务不调用真实识别端点(真实端点验收放 checklist.md 手工环节)。

---

## 执行顺序

```text
T1 → T2 → T3
 │     └──→ T5 → T7
 ├─→ T4 ──→ T8
 └─→ T6 ──→ T7
```

（T4 与 T6 可在 T1 完成后与 T2/T3 并行推进；T7 需要 T5 与 T6 都就绪。）
