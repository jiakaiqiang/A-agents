const verbs = ["思考中", "构思中", "推演中", "整理中", "编写中", "探索中"];
const completionVerbs = ["完成", "已就绪", "回复完成", "处理完成"];

export function randomVerb(): string {
  return verbs[Math.floor(Math.random() * verbs.length)]!;
}

export function randomCompletionVerb(): string {
  return completionVerbs[Math.floor(Math.random() * completionVerbs.length)]!;
}
