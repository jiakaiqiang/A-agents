// 密钥脱敏的唯一出口（spec N5）：由 runTool 在结果出口统一调用，各工具不自行脱敏。

const PLACEHOLDER = "[redacted]";

// 键值型：只替换 value，保留键名，便于模型仍能理解结构。
const KEY_VALUE =
  /\b(api[-_]?key|apikey|access[-_]?key|secret[-_]?key|token|secret|password|passwd|credential)(\s*[:=]\s*)(["']?)([^\s"',;{}()$]{6,})\3/gi;

// 独立的强特征模式：整体替换。
const STANDALONE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
];

const BEARER = /\b(Bearer\s+)([A-Za-z0-9._-]{16,})/gi;

// 判断键值型的 value 是否像密钥：避免把 `password = req.body.password` 这类代码误伤。
function looksLikeSecret(value: string): boolean {
  if (/[.()${}]/.test(value)) return false;
  if (value.length >= 16) return true;
  if (/\d/.test(value)) return true;
  return /[-_]/.test(value);
}

export function redact(text: string): string {
  if (!text) return text;

  let result = text;
  for (const pattern of STANDALONE) {
    result = result.replace(pattern, PLACEHOLDER);
  }
  result = result.replace(BEARER, (_match, prefix: string) => `${prefix}${PLACEHOLDER}`);
  result = result.replace(
    KEY_VALUE,
    (match: string, key: string, separator: string, quote: string, value: string) =>
      looksLikeSecret(value) ? `${key}${separator}${quote}${PLACEHOLDER}${quote}` : match,
  );
  return result;
}
