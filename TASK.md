# Skill 系统（一期）开发进度（task.md 锚点）

> 四份文档：docs/specs/skills/{spec,plan,task,checklist}.md，均已批准。
> 每项一行，做完打勾。验证命令在 typescript/ 下执行。

- [x] T1 src/skills/types.ts + limits.ts 常量
- [x] T2 parser.ts：parseSkill（frontmatter 校验、告警）+ 单测
- [x] T3 parser.ts：expandBody（$ARGUMENTS）+ 单测
- [x] T4 loader.ts：三级发现、覆盖、同层冲突 + 单测
- [x] T5 loader.ts：realpath / 64KB 安全读取、白名单校验 + 单测
- [x] T6 builtin/commit.md、review.md、test.md + 加载单测
- [x] T7 catalog.ts：skillCatalogSection、pinnedSection + 单测
- [x] T8 manager.ts：SkillManager + 单测
- [x] T9 工具层：Tool.system、allowedTools、only 过滤、runTool 拦截 + 测试
- [x] T10 permission：system → read + 测试
- [x] T11 LLM 适配器：StreamOptions.pinned、第三段 + 测试
- [x] T12 loop.ts：SkillView 接入 + 集成测试
- [x] T13 isolated.ts：recentHistory + 单测
- [x] T14 isolated.ts：runIsolatedSkill、isolatedToolScope、resultMessage + 单测
- [x] T15 load-tool.ts：loadSkill + 单测
- [x] T16 commands：CommandUI 三方法、SkillListItem、formatSkills、fake-ui
- [x] T17 commands/builtins/skills.ts：skillCommand、registerSkillCommands、/skills、bootstrapSkills；删 review.ts + 测试
- [x] T18 app.tsx：抽出 renderAgentEvent、finishTurn（纯重构）
- [x] T19 app.tsx：skills / skillReport props、目录进稳定段、runLoop 传 skills
- [x] T20 app.tsx：invokeSkill 共享分支、listSkills / deactivateSkills、clear / resume 停用
- [x] T21 app.tsx：runIsolatedTurn、isolatedClient、注入 runner
- [x] T22 main.tsx：bootstrapSkills 接线
- [x] T23 斜杠命令 Ink fixture 改用 review Skill
- [x] T24 Skill Ink fixture + 三次变异检验
- [x] T25 全量回归：typecheck 零错误；bun test 546 pass / 1 skip / 0 fail（基线 454 → 546，净增 92；删除 1 条旧 /review 用例）；依赖方向检查无违规
- [ ] T26 端到端手工验收（本机无 tmux，需用户在真实终端操作）
