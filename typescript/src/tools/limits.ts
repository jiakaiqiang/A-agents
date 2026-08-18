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
