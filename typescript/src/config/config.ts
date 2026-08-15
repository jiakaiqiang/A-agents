import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";

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

export interface MCPServerConfig {
  name: string;
  [key: string]: unknown;
}

export interface HookConfig {
  [key: string]: unknown;
}

export interface AppConfig {
  providers: ProviderConfig[];
  permission_mode?: string;
  mcp_servers: MCPServerConfig[];
  hooks: HookConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const EMPTY_CONFIG: AppConfig = { providers: [], mcp_servers: [], hooks: [] };
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

export function loadSingleFile(filePath: string): AppConfig {
  if (!existsSync(filePath)) {
    return { ...EMPTY_CONFIG, providers: [], mcp_servers: [], hooks: [] };
  }

  let parsed: unknown;
  try {
    parsed = load(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`无法解析配置文件 ${filePath}：${message}`);
  }

  if (parsed === undefined || parsed === null) {
    return { ...EMPTY_CONFIG, providers: [], mcp_servers: [], hooks: [] };
  }

  const raw = asRecord(parsed, filePath);
  return {
    providers: Array.isArray(raw.providers) ? raw.providers as ProviderConfig[] : [],
    permission_mode: typeof raw.permission_mode === "string" ? raw.permission_mode : undefined,
    mcp_servers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers as MCPServerConfig[] : [],
    hooks: Array.isArray(raw.hooks) ? raw.hooks as HookConfig[] : [],
  };
}

export function mergeConfig(base: AppConfig, override: AppConfig): AppConfig {
  const mcpByName = new Map<string, MCPServerConfig>();
  for (const server of base.mcp_servers) mcpByName.set(server.name, server);
  for (const server of override.mcp_servers) mcpByName.set(server.name, server);

  return {
    providers: override.providers.length > 0 ? override.providers : base.providers,
    permission_mode: override.permission_mode ?? base.permission_mode,
    mcp_servers: [...mcpByName.values()],
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
    { providers: [], mcp_servers: [], hooks: [] },
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
