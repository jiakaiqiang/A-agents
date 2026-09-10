import type { PermissionGate, PermissionMode, Rule, RuleSet } from "../../src/permission/types.js";

export function emptyRuleSet(): RuleSet {
  return { layers: { session: [], local: [], project: [], user: [] } };
}

export function bypassGate(overrides: Partial<PermissionGate> = {}): PermissionGate {
  return {
    mode: "bypass",
    rules: emptyRuleSet(),
    grantSession() {},
    grantAlways() {},
    ...overrides,
  };
}

export function gateWith(
  mode: PermissionMode,
  rules: RuleSet = emptyRuleSet(),
  extra: Partial<PermissionGate> = {},
): PermissionGate {
  return {
    mode,
    rules,
    grantSession() {},
    grantAlways() {},
    ...extra,
  };
}

export function pushRule(rules: RuleSet, rule: Rule): void {
  rules.layers[rule.source].push(rule);
}
