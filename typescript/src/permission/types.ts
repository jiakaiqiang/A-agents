// 权限系统的类型定义（spec F1–F25）。
// 判定层不依赖任何界面模块：交互确认以回调形式经 ToolContext 注入。

/** 四档权限模式，规则未命中时决定兜底行为（spec F14）。 */
export type PermissionMode = "plan" | "default" | "acceptEdits" | "bypass";

/** 工具分类，档位兜底表的行维度（spec F14）。 */
export type ToolClass = "read" | "write" | "bash";

/** 规则来源层，优先级 session > local > project > user（spec F12）。 */
export type RuleSource = "session" | "local" | "project" | "user";

/** 单条规则：由「工具名(模式)」解析而来（spec F9、F11）。 */
export interface Rule {
  tool: string; // 工具名，如 "Bash"
  pattern: string; // 括号内的模式原文，如 "git *"
  effect: "allow" | "deny";
  source: RuleSource;
  order: number; // 同层内的书写序号，越大越晚写；支撑「靠后的赢」（F13）
}

/** 四层规则集合。每层内部按 order 升序，匹配时取该层 order 最大的命中项（F13）。 */
export interface RuleSet {
  layers: Record<RuleSource, Rule[]>;
}

/** 给出最终判定的层，决定回给模型的原因文案前缀（spec N4）。 */
export type DecisionLayer = "blacklist" | "sandbox" | "rule" | "mode" | "human";

/**
 * 单层表态（spec F2）。
 * 黑名单与路径沙箱只能返回 deny 或 abstain——它们不具备放行能力，
 * 因此通过这两层不等于获得放行，也不可能成为跳过后续层的通道（spec N2）。
 * 规则层返回 allow / deny / abstain；档位兜底层返回 allow / ask，不返回 abstain。
 */
export type LayerVerdict = "allow" | "deny" | "ask" | "abstain";

export interface LayerResult {
  verdict: LayerVerdict;
  reason?: string;
}

/** 判定终态：对外只有放行与拒绝两种，ask 在流水线内部被人在回路消解（spec F1）。 */
export type PermissionDecision =
  | { verdict: "allow"; layer: DecisionLayer }
  | { verdict: "deny"; layer: DecisionLayer; reason: string };

/** 交互确认的请求内容（spec F20）。 */
export interface ConfirmRequest {
  toolName: string;
  summary: string; // 调用摘要，复用 tool.callSummary(args)
  ruleCandidate: string; // 永久放行会写入的规则文本，如 "Bash(npm test)"
}

/** 用户在确认框中的选择：三种放行粒度加拒绝（spec F20–F24）。 */
export type ConfirmChoice = "once" | "session" | "always" | "deny";

/**
 * 判定所需的全部外部能力，经 ToolContext 注入。
 * confirm 可缺省：非交互环境（测试、未来的非 TUI 入口）下需要确认的调用一律拒绝，
 * 不挂起等待，避免无人应答时死锁。
 */
export interface PermissionGate {
  mode: PermissionMode;
  rules: RuleSet;
  confirm?(request: ConfirmRequest): Promise<ConfirmChoice>;
  grantSession(rule: Rule): void;
  grantAlways(rule: Rule): void;
}
