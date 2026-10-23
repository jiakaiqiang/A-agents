---
name: commit
description: 按约定格式提交当前工作区的改动
tools: [Bash, Read, Glob, Grep]
mode: shared
---
按下面的步骤提交当前工作区的改动。

1. 运行 `git status` 与 `git diff`（含 `git diff --cached`）了解改动；需要时读取相关文件补充上下文。
2. 只提交与本次意图相关的文件：逐个暂存，不要用 `git add .`；疑似含密钥的文件（如 .env、credentials）先提醒用户，不要提交。
3. 按 `type(scope): 描述` 写提交说明：type 取 feat、fix、refactor、docs、test、chore 之一；描述说清改了什么、为什么改。
4. 提交前把要暂存的文件和提交说明列给用户确认，确认后再执行 `git commit`。
5. 不执行 push、rebase、reset 等改写或外发历史的命令。

提交说明关注点：$ARGUMENTS
