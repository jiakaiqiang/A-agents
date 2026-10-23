// 全部资源上限集中在此，便于统一调整（spec N3）。

export const BASH_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_CHARS = 30_000;

export const READ_MAX_LINES = 2_000;
export const READ_MAX_LINE_CHARS = 2_000;

export const GLOB_MAX_RESULTS = 100;

export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_FILE_BYTES = 1_000_000;
export const GREP_MAX_LINE_CHARS = 500;

export const TOOL_RESULT_MAX_CHARS = 30_000;
export const SUMMARY_MAX_CHARS = 72;

// ── Agent Loop 上限（spec N1）──
// 一轮内模型请求次数上限，兜底安全网：任何模型行为下循环都必须终止。
export const MAX_ITERATIONS = 25;
// 连续「全部调用都指向未知工具」的迭代次数阈值，防模型在不存在的工具上空转。
export const MAX_INVALID_ITERATIONS = 3;
// 并发批最大并发度，超出时切成多个并发子批依次跑，避免耗尽文件句柄。
export const MAX_CONCURRENT_TOOLS = 8;

// ── 系统提示词与运行期注入（spec N8）──
// 模块优先级，升序拼装：固定模块在前，可选模块居中，环境信息在最末。
// 单个 Skill 文件的大小上限：超过即跳过，防止一个超大文件撑爆上下文（Skill spec N5）。
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
// Skill 目录里一句说明的截断上限（Skill spec N1）。
export const SKILL_CATALOG_DESC_MAX_CHARS = 80;

export const PROMPT_PRIORITY = {
  identity: 0,
  safety: 10,
  taskMode: 20,
  behavior: 30,
  codeStyle: 40,
  usingTools: 50,
  outputStyle: 60,
  customInstructions: 70,
  skills: 80,
  memory: 90,
  environment: 100,
} as const;

// 计划模式完整版指令的重复间隔轮数：第 1 轮与之后每隔 5 轮注入完整版，其余轮次精简版。
export const PLAN_REMINDER_INTERVAL = 5;

// 记忆系统（memory spec N6）：所有阈值集中维护。
export const INSTRUCTION_FILE_NAME = "MEWCODE.md"; // F1
export const INCLUDE_MAX_DEPTH = 5; // F2
export const MEMORY_INDEX_MAX_LINES = 200; // F11
export const MEMORY_INDEX_MAX_BYTES = 25_000; // F11
export const SESSION_GAP_REMINDER_MS = 4 * 60 * 60 * 1000; // F8
export const SESSION_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // F9
export const SESSION_LIST_LIMIT = 20; // F7
export const SESSION_TITLE_MAX_CHARS = 50; // F6
export const MEMORY_LOCK_WAIT_MS = 2_000; // F16：等待记忆互斥的上限
export const MEMORY_LOCK_STALE_MS = 30_000; // F16：写入阶段只有毫秒级，持有超过此时长必是残留
export const LOCK_RETRY_INTERVAL_MS = 50; // F16：抢锁失败后的重试间隔

// 最小可缓存前缀长度门槛，按整个请求前缀（工具定义 + 系统提示词）计算。
// Anthropic Opus / Sonnet 为 1024，Haiku 为 2048；更换模型时需复核此值。
export const CACHE_MIN_PREFIX_TOKENS = 1024;

// Glob / Grep 统一忽略的目录名，避免把依赖与产物塞进上下文。
export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
]);
