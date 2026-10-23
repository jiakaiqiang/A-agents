---
name: review
description: 审查工作区未提交的改动
tools: [Bash, Read, Glob, Grep]
mode: shared
---
请对当前工作区未提交的改动做代码审查。

1. 先用 git diff 与 git diff --cached 查看改动；必要时读取相关文件补充上下文。
2. 按严重程度列出缺陷、潜在风险与改进建议，每条注明文件与位置。
3. 没有未提交的改动时直接说明，不要编造。
4. 只做审查，不修改文件。

审查范围：$ARGUMENTS
