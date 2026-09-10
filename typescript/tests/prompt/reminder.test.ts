import { describe, expect, test } from "bun:test";
import { ModeTracker, wrapReminder } from "../../src/prompt/reminder.js";
import { PLAN_REMINDER_INTERVAL } from "../../src/tools/limits.js";

describe("wrapReminder", () => {
  test("包成成对的 system-reminder 标签", () => {
    const wrapped = wrapReminder("注意事项");
    expect(wrapped.startsWith("<system-reminder>")).toBe(true);
    expect(wrapped.endsWith("</system-reminder>")).toBe(true);
    expect(wrapped).toContain("注意事项");
  });

  test("首尾空白被裁掉，标签紧贴内容", () => {
    expect(wrapReminder("\n\n  内容  \n\n")).toBe("<system-reminder>\n内容\n</system-reminder>");
  });
});

describe("ModeTracker", () => {
  test("执行模式不注入任何补充指令", () => {
    const tracker = new ModeTracker();
    expect(tracker.nextTurn()).toEqual([]);
    expect(tracker.nextTurn()).toEqual([]);
  });

  test("计划模式首轮发完整版", () => {
    const tracker = new ModeTracker();
    tracker.setMode("plan");
    const [first] = tracker.nextTurn();
    expect(first).toContain("<system-reminder>");
    expect(first).toContain("当前处于计划模式");
    expect(first).toContain("不要修改任何文件");
  });

  test("间隔轮次重复完整版，其余轮次精简", () => {
    const tracker = new ModeTracker();
    tracker.setMode("plan");
    const turns: string[] = [];
    for (let i = 0; i < PLAN_REMINDER_INTERVAL * 2; i += 1) {
      turns.push(tracker.nextTurn()[0]!);
    }
    const fullAt = turns
      .map((text, index) => (text.includes("这一模式下应该做的事") ? index : -1))
      .filter((index) => index >= 0);
    expect(fullAt).toEqual([0, PLAN_REMINDER_INTERVAL]);
    // 非完整轮仍要带住边界，只是体积更小。
    expect(turns[1]).toContain("仍在计划模式");
    expect(turns[1]!.length).toBeLessThan(turns[0]!.length);
  });

  test("每轮都有指令注入，不会出现空轮", () => {
    const tracker = new ModeTracker();
    tracker.setMode("plan");
    for (let i = 0; i < PLAN_REMINDER_INTERVAL + 2; i += 1) {
      expect(tracker.nextTurn()).toHaveLength(1);
    }
  });

  test("切回执行模式后停止注入，再切回计划模式重新从首轮算", () => {
    const tracker = new ModeTracker();
    tracker.setMode("plan");
    tracker.nextTurn();
    tracker.nextTurn();
    tracker.setMode("execute");
    expect(tracker.nextTurn()).toEqual([]);

    tracker.setMode("plan");
    const [again] = tracker.nextTurn();
    expect(again).toContain("这一模式下应该做的事");
  });

  test("重复设置同一模式不重置轮次计数", () => {
    const tracker = new ModeTracker();
    tracker.setMode("plan");
    tracker.nextTurn();
    tracker.setMode("plan");
    const [second] = tracker.nextTurn();
    expect(second).toContain("仍在计划模式");
  });
});
