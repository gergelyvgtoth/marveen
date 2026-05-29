#!/usr/bin/env bash
# Nightly 4am restart of all agents so CLAUDE.md changes take effect
set -e
for session in agent-coder agent-agrolanc agent-mutacsi agent-tanulo marveen-channels; do
  tmux kill-session -t "$session" 2>/dev/null || true
done
echo "$(date '+%Y-%m-%d %H:%M:%S') [restart-agents] all agents killed, watchdog restarts in 5m" >> /home/user/marveen/logs/watchdog.log
