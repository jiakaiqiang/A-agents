#!/bin/bash
# 端到端验证：在工具执行中按 Esc 取消，检查中止提示是否渲染。
set -u
cd /d/demo/jkq-agents/typescript

tmux kill-session -t canceltest 2>/dev/null
tmux new-session -d -s canceltest -x 140 -y 40 "bun run src/main.tsx"
sleep 7

tmux send-keys -t canceltest -l "用 Bash 执行 sleep 30 这个命令"
tmux send-keys -t canceltest Enter

# 等到进入工具执行阶段
for _ in $(seq 1 15); do
  if tmux capture-pane -p -t canceltest | grep -q "执行工具"; then
    break
  fi
  sleep 3
done

echo "=== 取消前最后一行 ==="
tmux capture-pane -p -t canceltest | sed '/^ *$/d' | tail -2

tmux send-keys -t canceltest Escape
sleep 8

echo "=== 取消后：查找独立的中止提示行 ==="
tmux capture-pane -p -t canceltest -S -120 | grep -n "本轮已中断" || echo "NOT_FOUND: 未找到独立中止提示"

echo "=== 取消后界面尾部 ==="
tmux capture-pane -p -t canceltest -S -120 | sed '/^ *$/d' | tail -14

echo "=== 会话是否仍可继续 ==="
tmux send-keys -t canceltest -l "2+3 等于几"
tmux send-keys -t canceltest Enter
for _ in $(seq 1 12); do
  if ! tmux capture-pane -p -t canceltest | grep -qE "思考中|等待模型|执行工具"; then
    break
  fi
  sleep 4
done
tmux capture-pane -p -t canceltest -S -40 | sed '/^ *$/d' | grep -nE "等于|❯" | tail -6

tmux kill-session -t canceltest 2>/dev/null
echo "=== DONE ==="
