#!/usr/bin/env bash
# 长对话下的滚动验证：动态区高度必须保持在终端行数以下，
# 否则 Ink 会走 clearTerminal 分支，把 scrollback 冲掉。
set -u
cd "$(dirname "$0")"
tmux kill-session -t sc 2>/dev/null
tmux new-session -d -s sc -x 100 -y 24 "bash -lc 'bun run src/main.tsx'"
sleep 6
for i in 1 2 3 4 5 6; do
  tmux send-keys -t sc "第 $i 条：用 Glob 找出 src 下所有 ts 文件" Enter
  for _ in $(seq 1 40); do
    if tmux capture-pane -p -t sc | grep -q "输入消息"; then break; fi
    sleep 2
  done
  sleep 1
done
echo "=== 可见屏幕行数 ==="
tmux capture-pane -p -t sc | wc -l
echo "=== scrollback 总行数（应远大于可见行数，说明历史沉进去了）==="
tmux capture-pane -p -t sc -S -2000 | wc -l
echo "=== 最早的用户消息是否还在 scrollback（滚上去能看到）==="
tmux capture-pane -p -t sc -S -2000 | grep -n "第 1 条" | head -2
echo "=== 最新一条是否也在 ==="
tmux capture-pane -p -t sc -S -2000 | grep -n "第 6 条" | head -2
echo "=== 静态区 banner 出现次数（应为 1，多次=反复清屏重画）==="
tmux capture-pane -p -t sc -S -2000 | grep -c "MewCode v0.1.0"
tmux kill-session -t sc 2>/dev/null
echo "=== DONE ==="
