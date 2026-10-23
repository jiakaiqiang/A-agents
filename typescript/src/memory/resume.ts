import { BOUNDARY_TEXT, SUMMARY_PREFIX, type Compactor } from "../context/compactor.js";
import type { ConversationManager, Message } from "../conversation/conversation.js";
import { SESSION_GAP_REMINDER_MS } from "../tools/limits.js";
import { readSessionLines, rebuildHistory, type SessionWriter } from "./session.js";

export interface ResumeOutcome {
  id: string;
  messageCount: number;
  skippedLines: number;
  truncated: boolean;
  compaction: "none" | "done" | "failed";
  gapReminder: string | null;
  display: { role: "user" | "assistant" | "system"; content: string }[];
}

export function formatGap(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return hours >= 24 ? `${Math.floor(hours / 24)} 天` : `${hours} 小时`;
}

export function displayMessages(messages: Message[], _summaryCount: number): ResumeOutcome["display"] {
  const display: ResumeOutcome["display"] = [];
  let folded = false;
  for (const message of messages) {
    if (message.content.startsWith(SUMMARY_PREFIX)) {
      if (!folded) display.push({ role: "system", content: "（较早的对话已压缩为摘要）" });
      folded = true;
      continue;
    }
    if (message.role === "system" || message.toolResults?.length || message.content === BOUNDARY_TEXT || message.content.startsWith("<system-reminder>") || !message.content.trim()) continue;
    // 提示词命令存的是展开文本，恢复时显示用户当时敲的原命令（斜杠命令 spec F5）。
    display.push({ role: message.role, content: message.display ?? message.content });
  }
  return display;
}

export async function resumeSession({ workDir, id, conversation, writer, compactor, now = new Date() }: {
  workDir: string;
  id: string;
  conversation: ConversationManager;
  writer: SessionWriter;
  compactor?: Compactor;
  now?: Date;
}): Promise<ResumeOutcome> {
  if (writer.id !== id) throw new Error("会话写入器与恢复 ID 不一致");
  const rebuilt = rebuildHistory(readSessionLines(workDir, id));
  conversation.restore(rebuilt.messages);
  conversation.setRecorder(writer);
  // 保存修复基线，否则下次重建会在同一处截断，丢掉这次恢复后的所有新消息。
  if (rebuilt.truncatedFrom !== null) writer.onReplace(conversation.getMessages());
  compactor?.estimator.resetAnchor();
  compactor?.resetFailures();
  let compaction: ResumeOutcome["compaction"] = "none";
  if (compactor?.needsCompaction()) {
    try { compaction = (await compactor.compactManually()).compacted ? "done" : "failed"; }
    catch { compaction = "failed"; }
  }
  let gapReminder: string | null = null;
  if (rebuilt.lastTimestamp && now.getTime() - rebuilt.lastTimestamp.getTime() > SESSION_GAP_REMINDER_MS) {
    gapReminder = `距上次对话已过去 ${formatGap(now.getTime() - rebuilt.lastTimestamp.getTime())}，期间文件可能已变化，涉及文件内容时请重新读取。`;
    // 使用 user 角色，以免 provider 丢弃历史中的 system 角色消息。
    conversation.addUserMessage(`<system-reminder>${gapReminder}</system-reminder>`);
  }
  return {
    id, messageCount: conversation.len(), skippedLines: rebuilt.skippedLines,
    truncated: rebuilt.truncatedFrom !== null, compaction, gapReminder,
    display: displayMessages(conversation.getMessages(), rebuilt.summaryCount),
  };
}
