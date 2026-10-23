import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import type { McpServerConfig } from "../mcp/types.js";

export type ProviderProtocol = "anthropic" | "openai" | "openai-compat";

export interface ProviderConfig {
  name: string;
  protocol: ProviderProtocol;
  base_url: string;
  model: string;
  api_key?: string;
  thinking?: boolean;
  context_window?: number;
  max_output_tokens?: number;
}

export interface ContextManagementConfig {
  auto_margin_tokens?: number;
  manual_margin_tokens?: number;
  keep_recent_tokens?: number;
  keep_recent_natural?: number;
  max_summary_failures?: number;
  tool_spill_tokens?: number;
  message_spill_tokens?: number;
  spill_preview_chars?: number;
}

export interface HookConfig {
  [key: string]: unknown;
}

export interface AppConfig {
  providers: ProviderConfig[];
  context_management?: ContextManagementConfig;
  permission_mode?: string;
  mcp_servers: Record<string, McpServerConfig>;
  mcp_warnings: string[];
  hooks: HookConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const EMPTY_CONFIG: AppConfig = { providers: [], context_management: {}, mcp_servers: {}, mcp_warnings: [], hooks: [] };
const PROTOCOLS: ProviderProtocol[] = ["anthropic", "openai", "openai-compat"];
const ENV_KEY_MAP: Record<ProviderProtocol, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compat": "OPENAI_API_KEY",
};

const MODEL_CONTEXT_WINDOWS: Array<[string, number]> = [
  ["claude", 1_000_000],
  ["gpt", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["deepseek", 128_000],
  ["qwen", 128_000],
];

const contextWindowCache = new Map<string, number>();

function asRecord(value: unknown, filePath: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`配置文件格式错误：${filePath} 顶层必须是 YAML 对象`);
  }

  return value as Record<string, unknown>;
}

function parseContextManagement(raw: unknown, filePath: string): ContextManagementConfig {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`配置文件格式错误：${filePath} 的 context_management 必须是 YAML 对象`);
  }
  const result: ContextManagementConfig = {};
  for (const key of [
    "auto_margin_tokens", "manual_margin_tokens", "keep_recent_tokens", "keep_recent_natural",
    "max_summary_failures", "tool_spill_tokens", "message_spill_tokens", "spill_preview_chars",
  ] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new ConfigError(`配置文件格式错误：context_management.${key} 必须是正数（${filePath}）`);
      }
      result[key] = value;
    }
  }
  return result;
}

/**
 * ${VAR} 展开（spec F2）：占位符替换为一个变量。
 * lookup 返回 undefined 视为未定义：展开为空串并产生警告。
 */
export function expandEnvVars(
  value: string,
  lookup: (name: string) => string | undefined,
): { value: string; warnings: string[] } {
  const warnings: string[] = [];
  const expanded = value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const resolved = lookup(name);
    if (resolved === undefined) {
      warnings.push(`环境变量 ${name} 未定义，已展开为空串`);
      return "";
    }
    return resolved;
  });
  return { value: expanded, warnings };
}

/**
 * 把 YAML map 里的一个 Server 项归一化为 McpServerConfig（spec F1、F2）。
 * 非法项不抛异常：跳过并出警告，不影响其他 Server（spec N4）。
 */
function resolveMcpServer(
  name: string,
  raw: unknown,
  filePath: string,
): { config?: McpServerConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`mcp_servers.${name} 必须是对象，已跳过（${filePath}）`);
    return { warnings };
  }

  const record = raw as Record<string, unknown>;
  const type = record.type === "http" ? "http" : "stdio";
  const config: McpServerConfig = {
    type,
    enabled: record.enabled === undefined ? true : record.enabled === true,
    ...(typeof record.timeout === "number" && record.timeout > 0 ? { timeout: record.timeout } : {}),
  };

  if (type === "stdio") {
    if (typeof record.command !== "string" || record.command.trim() === "") {
      warnings.push(`mcp_servers.${name}: stdio 类型缺少 command，已跳过（${filePath}）`);
      return { warnings };
    }
    config.command = record.command;
    if (Array.isArray(record.args)) {
      config.args = record.args.filter((item): item is string => typeof item === "string");
    }
    // env 值支持 ${VAR} 展开；查找顺序：同 Server env 的前置键 → 进程环境变量（spec F2）。
    if (record.env !== undefined && record.env !== null && typeof record.env === "object" && !Array.isArray(record.env)) {
      const rawEnv = record.env as Record<string, unknown>;
      const envKeys = Object.keys(rawEnv);
      const env: Record<string, string> = {};
      for (const key of envKeys) {
        const value = rawEnv[key];
        if (typeof value !== "string") continue;
        const lookup = (variable: string): string | undefined => {
          const index = envKeys.indexOf(variable);
          if (index >= 0 && index < envKeys.indexOf(key)) {
            const prior = rawEnv[variable];
            return typeof prior === "string" ? prior : undefined;
          }
          return process.env[variable];
        };
        env[key] = expandEnvVars(value, lookup).value;
        warnings.push(...expandEnvVars(value, lookup).warnings.map((text) => `mcp_servers.${name}.env.${key}: ${text}`));
      }
      config.env = env;
    }
  } else {
    if (typeof record.url !== "string" || record.url.trim() === "") {
      warnings.push(`mcp_servers.${name}: http 类型缺少 url，已跳过（${filePath}）`);
      return { warnings };
    }
    try {
      new URL(record.url);
    } catch {
      warnings.push(`mcp_servers.${name}: url 不是有效 URL，已跳过（${filePath}）`);
      return { warnings };
    }
    config.url = record.url;
    if (record.headers !== undefined && record.headers !== null && typeof record.headers === "object" && !Array.isArray(record.headers)) {
      const rawHeaders = record.headers as Record<string, unknown>;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value !== "string") continue;
        headers[key] = expandEnvVars(value, (variable) => process.env[variable]).value;
      }
      config.headers = headers;
    }
  }

  return { config, warnings };
}

/** 把整个 mcp_servers map 解析归一化；导出供测试与启动层使用。 */
export function parseMcpServers(
  raw: unknown,
  filePath: string,
): { servers: Record<string, McpServerConfig>; warnings: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { servers, warnings };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`mcp_servers 必须是 map（${filePath}）`);
    return { servers, warnings };
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const { config, warnings: itemWarnings } = resolveMcpServer(name, value, filePath);
    warnings.push(...itemWarnings);
    if (config) servers[name] = config;
  }
  return { servers, warnings };
}

export function loadSingleFile(filePath: string): AppConfig {
  if (!existsSync(filePath)) {
    return { ...EMPTY_CONFIG, providers: [], context_management: {}, mcp_servers: {}, mcp_warnings: [], hooks: [] };
  }

  let parsed: unknown;
  try {
    parsed = load(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`无法解析配置文件 ${filePath}：${message}`);
  }

  if (parsed === undefined || parsed === null) {
    return { ...EMPTY_CONFIG, providers: [], context_management: {}, mcp_servers: {}, mcp_warnings: [], hooks: [] };
  }

  const raw = asRecord(parsed, filePath);
  const mcp = parseMcpServers(raw.mcp_servers, filePath);
  return {
    providers: Array.isArray(raw.providers) ? raw.providers as ProviderConfig[] : [],
    context_management: parseContextManagement(raw.context_management, filePath),
    permission_mode: typeof raw.permission_mode === "string" ? raw.permission_mode : undefined,
    mcp_servers: mcp.servers,
    mcp_warnings: mcp.warnings,
    hooks: Array.isArray(raw.hooks) ? raw.hooks as HookConfig[] : [],
  };
}

export function mergeConfig(base: AppConfig, override: AppConfig): AppConfig {
  // map 键级覆盖：同名单者后者整体替换前者（spec F3）。
  const mcpServers = { ...base.mcp_servers, ...override.mcp_servers };
  return {
    providers: override.providers.length > 0 ? override.providers : base.providers,
    context_management: { ...base.context_management, ...override.context_management },
    permission_mode: override.permission_mode ?? base.permission_mode,
    mcp_servers: mcpServers,
    mcp_warnings: [...base.mcp_warnings, ...override.mcp_warnings],
    hooks: [...base.hooks, ...override.hooks],
  };
}

export function validateProviders(providers: ProviderConfig[]): void {
  if (providers.length === 0) {
    throw new ConfigError("至少需要配置一个 provider");
  }

  providers.forEach((provider, index) => {
    if (provider === null || typeof provider !== "object") {
      throw new ConfigError(`Provider #${index + 1}: 配置项必须是对象`);
    }

    const missing = ["name", "protocol", "base_url", "model"].filter((field) => {
      const value = provider[field as keyof ProviderConfig];
      return typeof value !== "string" || value.trim() === "";
    });
    if (missing.length > 0) {
      throw new ConfigError(`Provider #${index + 1}: 缺少必要字段：${missing.join(", ")}`);
    }

    if (!PROTOCOLS.includes(provider.protocol)) {
      throw new ConfigError(
        `Provider #${index + 1}: 非法 protocol '${String(provider.protocol)}'，仅支持：${PROTOCOLS.join(", ")}`,
      );
    }

    try {
      new URL(provider.base_url);
    } catch {
      throw new ConfigError(`Provider #${index + 1}: base_url 不是有效 URL`);
    }
  });
}

export function loadConfig(filePath?: string): AppConfig {
  if (filePath) {
    const config = loadSingleFile(filePath);
    validateProviders(config.providers);
    return config;
  }

  const paths = [
    join(homedir(), ".mewcode", "config.yaml"),
    join(process.cwd(), ".mewcode", "config.yaml"),
    join(process.cwd(), ".mewcode", "config.local.yaml"),
  ];
  const existingPaths = paths.filter(existsSync);
  if (existingPaths.length === 0) {
    throw new ConfigError("未找到配置文件。请创建 .mewcode/config.yaml，或复制 .mewcode/config.yaml.example 后填写配置。");
  }

  const config = existingPaths.reduce<AppConfig>(
    (merged, currentPath) => mergeConfig(merged, loadSingleFile(currentPath)),
    { providers: [], context_management: {}, mcp_servers: {}, mcp_warnings: [], hooks: [] },
  );
  validateProviders(config.providers);
  return config;
}

export function resolveAPIKey(provider: ProviderConfig): string {
  return provider.api_key?.trim() || process.env[ENV_KEY_MAP[provider.protocol]]?.trim() || "";
}

export function getMaxOutputTokens(provider: ProviderConfig): number {
  if (typeof provider.max_output_tokens === "number" && provider.max_output_tokens > 0) {
    return provider.max_output_tokens;
  }
  return provider.thinking ? 64_000 : 8_192;
}

export function lookupModelContextWindow(model: string): number {
  const lowerModel = model.toLowerCase();
  return MODEL_CONTEXT_WINDOWS.find(([needle]) => lowerModel.includes(needle))?.[1] ?? 0;
}

export function getContextWindow(provider: ProviderConfig): number {
  if (typeof provider.context_window === "number" && provider.context_window > 0) {
    return provider.context_window;
  }
  return lookupModelContextWindow(provider.model) || (provider.protocol === "anthropic" ? 200_000 : 128_000);
}

export async function getContextWindowAsync(
  provider: ProviderConfig,
  fetcher?: (provider: ProviderConfig) => Promise<number>,
): Promise<number> {
  const cacheKey = `${provider.name}:${provider.model}`;
  const cached = contextWindowCache.get(cacheKey);
  if (cached) return cached;

  let value = getContextWindow(provider);
  if (provider.protocol === "anthropic" && !provider.context_window && fetcher) {
    try {
      value = await fetcher(provider) || value;
    } catch {
      // 自动探测失败时保持同步回退值，且不阻塞启动。
    }
  }
  contextWindowCache.set(cacheKey, value);
  return value;
}

export function _resetContextWindowCache(): void {
  contextWindowCache.clear();
}
