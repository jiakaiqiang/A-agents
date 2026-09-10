import { describe, expect, test } from "bun:test";
import { checkRules, matchRule, parseRule, ruleTextFor } from "../../src/permission/rules.js";
import type { Rule, RuleSet, RuleSource } from "../../src/permission/types.js";
import { BashTool } from "../../src/tools/bash.js";
import { emptyRuleSet } from "./helpers.js";

function rule(effect: "allow" | "deny", text: string, source: RuleSource, order: number): Rule {
  const parsed = parseRule(text, effect, source, order);
  if (!parsed) throw new Error(`无法解析规则：${text}`);
  return parsed;
}

function set(entries: Array<[RuleSource, Array<["allow" | "deny", string]>]>): RuleSet {
  const rules = emptyRuleSet();
  for (const [source, items] of entries) {
    rules.layers[source] = items.map(([effect, text], order) => rule(effect, text, source, order));
  }
  return rules;
}

describe("parseRule", () => {
  test("解析工具名与模式", () => {
    const parsed = parseRule("Bash(git *)", "allow", "project", 0);
    expect(parsed?.tool).toBe("Bash");
    expect(parsed?.pattern).toBe("git *");
  });

  test("模式内括号取末个右括号", () => {
    expect(parseRule("Bash(echo (x))", "allow", "project", 0)?.pattern).toBe("echo (x)");
  });

  test("缺括号返回 undefined", () => {
    expect(parseRule("Bash", "allow", "project", 0)).toBeUndefined();
    expect(parseRule("(x)", "allow", "project", 0)).toBeUndefined();
  });
});

describe("matchRule", () => {
  test("glob 命中 git status", () => {
    expect(matchRule(rule("allow", "Bash(git *)", "project", 0), "Bash", { command: "git status" })).toBe(true);
  });

  test("精确匹配不泛化", () => {
    const npm = rule("allow", "Bash(npm test)", "project", 0);
    expect(matchRule(npm, "Bash", { command: "npm test" })).toBe(true);
    expect(matchRule(npm, "Bash", { command: "npm test --watch" })).toBe(false);
  });

  test("命令串联整串匹配", () => {
    expect(matchRule(rule("allow", "Bash(git *)", "project", 0), "Bash", {
      command: "git status && mv src /tmp",
    })).toBe(true);
  });
});

describe("checkRules", () => {
  test("跨层：本地盖过项目，本地盖过用户", () => {
    const allowLocal = set([
      ["project", [["deny", "Bash(git status)"]]],
      ["local", [["allow", "Bash(git status)"]]],
    ]);
    expect(checkRules(allowLocal, "Bash", { command: "git status" }).verdict).toBe("allow");

    const denyLocal = set([
      ["user", [["allow", "Bash(git status)"]]],
      ["local", [["deny", "Bash(git status)"]]],
    ]);
    expect(checkRules(denyLocal, "Bash", { command: "git status" }).verdict).toBe("deny");
  });

  test("同层靠后的赢", () => {
    const laterAllow = set([["project", [["deny", "Bash(git *)"], ["allow", "Bash(git *)"]]]]);
    expect(checkRules(laterAllow, "Bash", { command: "git status" }).verdict).toBe("allow");

    const laterDeny = set([["project", [["allow", "Bash(git *)"], ["deny", "Bash(git *)"]]]]);
    expect(checkRules(laterDeny, "Bash", { command: "git status" }).verdict).toBe("deny");
  });

  test("无规则不表态", () => {
    expect(checkRules(emptyRuleSet(), "Bash", { command: "npm test" }).verdict).toBe("abstain");
  });
});

describe("ruleTextFor", () => {
  test("Bash 精确整串", () => {
    expect(ruleTextFor(BashTool, { command: "npm test" })).toBe("Bash(npm test)");
  });
});
