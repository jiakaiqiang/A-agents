---
name: test
description: 运行项目测试并汇总失败原因
tools: [Bash, Read, Glob, Grep]
mode: isolated
history: 0
---
运行当前项目的测试并汇总结果。

1. 识别测试命令：查看 package.json 的 scripts、Makefile、pyproject.toml、go.mod 等，选出项目约定的测试命令。
2. 运行测试；如果给了测试范围，只运行与范围相关的测试。
3. 有失败时读取失败用例与相关源码，归纳每个失败的直接原因。
4. 只做诊断，不修改文件。
5. 最后一条回复写成结论：通过与失败的数量、每个失败的用例名与原因、建议的下一步。这条回复会作为结果交回主对话。

测试范围：$ARGUMENTS
