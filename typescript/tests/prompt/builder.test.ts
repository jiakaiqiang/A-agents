import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, detectEnvironment, PromptBuilder } from "../../src/prompt/builder.js";
import type { EnvironmentContext } from "../../src/prompt/sections.js";
import { CACHE_MIN_PREFIX_TOKENS, PROMPT_PRIORITY } from "../../src/tools/limits.js";
import { createDefaultRegistry } from "../../src/tools/index.js";

const environment: EnvironmentContext = {
  workDir: "/work/demo",
  os: "linux",
  arch: "x64",
  shell: "/bin/bash",
  isGitRepo: true,
  gitBranch: "dev",
  model: "claude-opus-5",
  date: "2026-09-09",
};

function toolSummaries() {
  return createDefaultRegistry().list().map((tool) => ({ name: tool.name, description: tool.description }));
}

/** 中文按一字一 token，其余按四字符一 token 估算，误差约 ±15%，够用来判断是否过缓存门槛。 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

describe("PromptBuilder", () => {
  test("按优先级排序拼装，空内容模块被丢掉", () => {
    const output = new PromptBuilder()
      .add({ name: "B", priority: 20, content: "第二段" })
      .add({ name: "Empty", priority: 15, content: "   " })
      .add({ name: "A", priority: 10, content: "第一段" })
      .build();
    expect(output).toBe("第一段\n\n第二段");
  });

  test("插入新模块只需给一个优先级，不改动已有模块", () => {
    const output = new PromptBuilder()
      .add({ name: "Identity", priority: PROMPT_PRIORITY.identity, content: "身份" })
      .add({ name: "New", priority: PROMPT_PRIORITY.safety - 1, content: "新模块" })
      .add({ name: "Safety", priority: PROMPT_PRIORITY.safety, content: "安全" })
      .build();
    expect(output).toBe("身份\n\n新模块\n\n安全");
  });
});

describe("buildSystemPrompt", () => {
  test("返回稳定段与环境段两个缓存单元", () => {
    const segments = buildSystemPrompt(environment, { tools: toolSummaries() });
    expect(segments.stable).toContain("# 身份");
    expect(segments.stable).toContain("# 安全边界");
    expect(segments.environment).toContain("# 运行环境");
    // 环境信息不能漏进稳定段，否则日期一变整个前缀失效。
    expect(segments.stable).not.toContain("# 运行环境");
    expect(segments.stable).not.toContain(environment.date);
    expect(segments.stable).not.toContain(environment.model);
  });

  test("七个固定模块按优先级出现在稳定段", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    const headings = ["# 身份", "# 安全边界", "# 任务模式", "# 行为", "# 代码规范", "# 工具使用", "# 输出风格"];
    const positions = headings.map((heading) => stable.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  test("可选模块按优先级排在固定模块之后，缺省时不出现", () => {
    const withOptional = buildSystemPrompt(environment, {
      tools: toolSummaries(),
      customInstructions: "# 项目约定\n用中文注释。",
      skills: "# 已激活 Skill\nspec-flow",
      memory: "# 长期记忆\n用户偏好 bun。",
    });
    const styleAt = withOptional.stable.indexOf("# 输出风格");
    const customAt = withOptional.stable.indexOf("# 项目约定");
    const skillAt = withOptional.stable.indexOf("# 已激活 Skill");
    const memoryAt = withOptional.stable.indexOf("# 长期记忆");
    expect(styleAt).toBeLessThan(customAt);
    expect(customAt).toBeLessThan(skillAt);
    expect(skillAt).toBeLessThan(memoryAt);

    const bare = buildSystemPrompt(environment, { tools: toolSummaries() });
    expect(bare.stable).not.toContain("# 项目约定");
    expect(bare.stable).not.toContain("# 已激活 Skill");
    expect(bare.stable).not.toContain("# 长期记忆");
  });

  test("同样入参两次构造字节一致，缓存才可能命中", () => {
    const first = buildSystemPrompt(environment, { tools: toolSummaries() });
    const second = buildSystemPrompt(environment, { tools: toolSummaries() });
    expect(first.stable).toBe(second.stable);
    expect(first.environment).toBe(second.environment);
  });

  test("工具清单只列名称，不重复完整描述", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    expect(stable).toContain("可用工具：Read、Write、Edit、Bash、Glob、Grep");
    // 完整描述随请求的 tools 参数下发，提示词里重复一遍等于白付近千 token。
    for (const tool of toolSummaries()) {
      expect(stable).not.toContain(tool.description);
    }
  });

  test("未配置工具时给出纯文本协助说明", () => {
    const { stable } = buildSystemPrompt(environment, { tools: [] });
    expect(stable).toContain("尚未配置工具调用能力");
  });

  test("稳定段单独就超过缓存最小前缀长度", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    // 计划模式下只读工具定义偏少，稳定段自己够长才能保证前缀过门槛。
    expect(estimateTokens(stable)).toBeGreaterThan(CACHE_MIN_PREFIX_TOKENS);
  });

  test("提示词不含密钥类字段的值", () => {
    const segments = buildSystemPrompt(environment, { tools: toolSummaries() });
    const whole = `${segments.stable}\n${segments.environment}`;
    expect(whole).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(whole).not.toContain("ANTHROPIC_API_KEY=");
  });

  test("模块之间恰好一个空行，首尾无多余空白", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    expect(stable).not.toContain("\n\n\n");
    expect(stable.startsWith("# 身份")).toBe(true);
    expect(stable.trimEnd()).toBe(stable);
  });

  test("可选模块传纯空白时不留下多余空行", () => {
    const { stable } = buildSystemPrompt(environment, {
      tools: toolSummaries(),
      customInstructions: "   ",
      skills: "\n\n",
      memory: "",
    });
    expect(stable).not.toContain("\n\n\n");
    expect(stable.trimEnd()).toBe(stable);
  });

  test("环境段含目录、系统与架构、Shell、Git 分支、模型、日期六项", () => {
    const { environment: envSegment } = buildSystemPrompt(environment, { tools: toolSummaries() });
    for (const value of [
      environment.workDir,
      environment.os,
      environment.arch,
      environment.shell,
      environment.gitBranch,
      environment.model,
      environment.date,
    ]) {
      expect(envSegment).toContain(value);
    }
  });

  test("只有环境信息变化时稳定段逐字节不变", () => {
    const first = buildSystemPrompt(environment, { tools: toolSummaries() });
    const second = buildSystemPrompt(
      { ...environment, date: "2026-12-31", gitBranch: "main", model: "claude-sonnet-5" },
      { tools: toolSummaries() },
    );
    expect(second.stable).toBe(first.stable);
    expect(second.environment).not.toBe(first.environment);
  });

  test("稳定段始终列全量工具，与当前模式无关", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    // 计划模式实际只下发三个只读工具，稳定段仍列六个：
    // 随模式增删会改变稳定段字节，切一次模式就废掉整个缓存前缀。
    for (const name of ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]) {
      expect(stable).toContain(name);
    }
  });

  test("稳定段不声明当前处于哪种模式", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    expect(stable).not.toContain("当前处于计划模式");
    expect(stable).not.toContain("当前处于执行模式");
    // 任务模式一节只解释两种模式的差别，具体处于哪种由运行期补充指令带入。
    expect(stable).toContain("当前处于哪种模式会在对话中另行告知");
  });

  test("工具使用模块不含计划模式的行为约束", () => {
    const { stable } = buildSystemPrompt(environment, { tools: toolSummaries() });
    const usingTools = stable.slice(stable.indexOf("# 工具使用"), stable.indexOf("# 输出风格"));
    expect(usingTools.length).toBeGreaterThan(0);
    expect(usingTools).not.toContain("计划模式");
    expect(usingTools).not.toContain("批准");
  });
});

describe("detectEnvironment", () => {
  test("采集工作目录、系统信息与模型名", () => {
    const detected = detectEnvironment("/tmp/demo", "claude-opus-5");
    expect(detected.workDir).toBe("/tmp/demo");
    expect(detected.model).toBe("claude-opus-5");
    expect(detected.os.length).toBeGreaterThan(0);
    expect(detected.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("非 Git 目录不影响采集", () => {
    const detected = detectEnvironment("/", "");
    expect(typeof detected.isGitRepo).toBe("boolean");
  });
});
