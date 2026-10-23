import type { CommandUI, StatusSnapshot, UsageSnapshot } from "../../src/commands/types.js";

export interface UICall {
  method: keyof CommandUI;
  args: unknown[];
}

export const FAKE_SNAPSHOT: StatusSnapshot = {
  provider: { name: "test", protocol: "openai-compat", model: "m", baseUrl: "https://api.example.com/v1?key=SECRET" },
  permissionMode: "default",
  rules: { layers: { session: [], local: [], project: [], user: [] } },
  session: { id: "20260101-000000-abcd", messageCount: 3, path: "/w/.mewcode/sessions/20260101-000000-abcd.jsonl" },
  memory: { user: [], project: [] },
  mcp: [],
};

export const FAKE_USAGE: UsageSnapshot = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  contextWindow: 128_000, usedTokens: 1_000,
};

/** 记录每次调用的 CommandUI 假实现；overrides 可替换任一方法的返回值。 */
export function fakeUI(overrides: Partial<CommandUI> = {}): { ui: CommandUI; calls: UICall[] } {
  const calls: UICall[] = [];
  const defaults: CommandUI = {
    showMessage: () => undefined,
    sendUserMessage: () => true,
    setPermissionMode: () => undefined,
    getUsage: () => FAKE_USAGE,
    refreshStatus: () => undefined,
    clearConversation: () => undefined,
    compact: () => Promise.resolve(),
    openResume: () => undefined,
    exit: () => undefined,
    snapshot: () => FAKE_SNAPSHOT,
    listSkills: () => [],
    deactivateSkills: () => [],
    invokeSkill: () => true,
  };
  const ui = {} as CommandUI;
  for (const method of Object.keys(defaults) as Array<keyof CommandUI>) {
    const impl = (overrides[method] ?? defaults[method]) as (...args: unknown[]) => unknown;
    (ui as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };
  }
  return { ui, calls };
}

/** 所有 showMessage 的文本。 */
export function messages(calls: UICall[]): string[] {
  return calls.filter((call) => call.method === "showMessage").map((call) => String(call.args[0]));
}

/** 除 showMessage 与只读查询外的调用：用于断言本地命令不改状态（spec AC8）。 */
export function mutations(calls: UICall[]): UICall[] {
  const readonly: Array<keyof CommandUI> = ["showMessage", "snapshot", "getUsage", "listSkills"];
  return calls.filter((call) => !readonly.includes(call.method));
}
