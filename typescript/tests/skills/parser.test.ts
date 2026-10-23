import { describe, expect, test } from "bun:test";
import { expandBody, parseSkill } from "../../src/skills/parser.js";

const meta = { dirName: "commit", source: "project" as const, path: "/p/.mewcode/skills/commit.md" };
const file = (frontmatter: string, body = "正文") => `---\n${frontmatter}\n---\n${body}\n`;

describe("parseSkill 失败场景（AC1）", () => {
  const cases: Array<[string, string, string]> = [
    ["缺 name", file("description: 提交"), "name"],
    ["缺 description", file("name: commit"), "description"],
    ["mode 非法", file("name: commit\ndescription: 提交\nmode: forked"), "mode"],
    ["name 含大写", file("name: Commit\ndescription: 提交"), "name 不合法"],
    ["正文为空", file("name: commit\ndescription: 提交", "   "), "正文为空"],
    ["frontmatter 不是合法 YAML", file("name: commit\ndescription: [未闭合"), "不是合法 YAML"],
    ["缺少 frontmatter", "只有正文", "frontmatter"],
    ["name 与文件名不一致", file("name: other\ndescription: 提交"), "不一致"],
    ["description 多行", file("name: commit\ndescription: |\n  第一行\n  第二行"), "一行"],
    ["tools 不是列表", file("name: commit\ndescription: 提交\ntools: Bash"), "tools"],
    ["history 为负数", file("name: commit\ndescription: 提交\nmode: isolated\nhistory: -1"), "history"],
  ];
  for (const [label, text, keyword] of cases) {
    test(label, () => {
      const result = parseSkill(text, meta);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(keyword);
    });
  }
});

describe("parseSkill 成功场景", () => {
  test("完整的独立模式 Skill 字段全部映射", () => {
    const result = parseSkill(file("name: commit\ndescription: 提交改动\ntools: [Bash, Read]\nmode: isolated\nhistory: 2\nmodel: small-model", "# SOP\n做事"), meta);
    expect(result).toEqual({
      ok: true,
      warnings: [],
      skill: {
        name: "commit", description: "提交改动", tools: ["Bash", "Read"], mode: "isolated", history: 2, model: "small-model",
        body: "# SOP\n做事", source: "project", path: meta.path,
      },
    });
  });

  test("缺省值：共享模式、不收窄、history 为 0", () => {
    const result = parseSkill(file("name: commit\ndescription: 提交"), meta);
    expect(result.ok && result.skill).toMatchObject({ mode: "shared", tools: null, history: 0 });
    expect(result.ok && "model" in result.skill).toBe(false);
  });

  test("未知字段与共享模式下的 history/model 只告警（AC1）", () => {
    const result = parseSkill(file("name: commit\ndescription: 提交\nauthor: me\nhistory: 3\nmodel: x"), meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual(["未知字段 author，已忽略", "共享模式忽略 history", "共享模式忽略 model"]);
    expect(result.skill.history).toBe(0);
    expect("model" in result.skill).toBe(false);
  });

  test("BOM 与 CRLF 文件可解析", () => {
    const result = parseSkill("﻿---\r\nname: commit\r\ndescription: 提交\r\n---\r\n正文\r\n", meta);
    expect(result.ok && result.skill.body).toBe("正文");
  });
});

describe("expandBody（AC2）", () => {
  test("每一处 $ARGUMENTS 都被替换，参数去首尾空白", () => {
    expect(expandBody("A:$ARGUMENTS B:$ARGUMENTS", "  x  ")).toBe("A:x B:x");
  });
  test("无参时替换为空", () => {
    expect(expandBody("关注点：$ARGUMENTS", "")).toBe("关注点：");
  });
  test("正文无占位符而传了参数时追加到末尾，中间空一行", () => {
    expect(expandBody("做事\n", "范围")).toBe("做事\n\n范围");
    expect(expandBody("做事", "  ")).toBe("做事");
  });
  test("参数里的替换模式字符原样保留", () => {
    expect(expandBody("[$ARGUMENTS]", "$& $1 $$")).toBe("[$& $1 $$]");
  });
});
