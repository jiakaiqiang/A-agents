import { expect, test } from "bun:test";
import { pinnedSection, skillCatalogSection } from "../../src/skills/catalog.js";
import { makeSkill } from "./helpers.js";

test("目录只含名字与说明，不含任何 SOP 正文（AC7）", () => {
  const text = skillCatalogSection([makeSkill("commit"), makeSkill("test", { mode: "isolated" })]);
  expect(text).toContain("- commit: commit 说明");
  expect(text).toContain("- test: test 说明（独立运行）");
  expect(text).toContain("loadSkill");
  expect(text).not.toContain("SOP_");
});

test("超长说明截断到 80 字符以内并加省略号（N1）", () => {
  const line = skillCatalogSection([makeSkill("long", { description: "说".repeat(120) })]).split("\n").at(-1)!;
  const description = line.slice("- long: ".length);
  expect(description).toHaveLength(80);
  expect(description.endsWith("…")).toBe(true);
});

test("没有 Skill 时目录为空串", () => {
  expect(skillCatalogSection([])).toBe("");
});

test("钉住区按传入顺序排列，没有激活时为空串", () => {
  const text = pinnedSection([
    { skill: makeSkill("b"), expanded: "B 的全文" },
    { skill: makeSkill("a"), expanded: "A 的全文" },
  ]);
  expect(text.indexOf("## Skill: b")).toBeLessThan(text.indexOf("## Skill: a"));
  expect(text).toContain("B 的全文");
  expect(text.startsWith("<active-skills>")).toBe(true);
  expect(pinnedSection([])).toBe("");
});
