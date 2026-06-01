#!/bin/bash
# Marveen fleet watchdog (idea #5, variant A: tmux-compatible).
#
# Checks each sub-agent's `agent-<id>` tmux session. If one is gone, restarts
# it with the SAME launch command the marveen-agent-start skill documents
# (NOT the broken API start). Tracks consecutive failures per agent; only a
# persistent failure (>= ALERT_THRESHOLD cycles still down after a restart
# attempt) is written to the alert marker for the agent layer to notify.
#
# Compatible with the existing runtime: it does NOT replace tmux, it guards it.
#
# Usage:
#   bash scripts/fleet-watchdog.sh            # heal mode: restart missing agents
#   bash scripts/fleet-watchdog.sh --dry-run  # report only, never restart
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd -P)"
AGENTS_DIR="$ROOT/agents"
STATE="$ROOT/store/fleet-watchdog-state.json"
LOG="$ROOT/store/fleet-watchdog.log"
ALERT_THRESHOLD=3
CLAUDE_BIN="$HOME/.local/bin/claude"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# SAFETY: if the tmux server is unreachable from here (e.g. wrong socket under
# systemd), we CANNOT tell which agents are down -- bailing out prevents
# spawning duplicate sessions. There is always at least marveen-channels, so a
# total failure to list means the socket is not visible, not "zero sessions".
if ! tmux ls >/dev/null 2>&1; then
  log "tmux server unreachable -- skipping (no restarts to avoid duplicates)"
  echo "tmux unreachable, skipped (exit 0)"
  exit 0
fi

start_agent() {
  local AGENT="$1"
  local AGENT_DIR="$AGENTS_DIR/$AGENT"
  local CHAN_DIR="$AGENT_DIR/.claude/channels/telegram"
  local MODEL
  MODEL=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/agent-config.json')); print(d.get('model','claude-opus-4-7'))" 2>/dev/null || echo "claude-opus-4-7")
  tmux new-session -d -s "agent-${AGENT}" \
    "export PATH=\"\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && \
     unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && \
     export TELEGRAM_STATE_DIR=\"$CHAN_DIR\" && \
     cd \"$AGENT_DIR\" && \
     $CLAUDE_BIN --dangerously-skip-permissions --model $MODEL --channels plugin:telegram@claude-plugins-official"
}

# Load state (per-agent consecutive-down counter) via python for safe JSON.
read_count() { python3 -c "import json,os;s=json.load(open('$STATE')) if os.path.exists('$STATE') else {};print(s.get('$1',0))" 2>/dev/null || echo 0; }
write_state() { # args: agent count
  python3 -c "
import json,os
s=json.load(open('$STATE')) if os.path.exists('$STATE') else {}
s['$1']=$2
json.dump(s,open('$STATE','w'))
" 2>/dev/null || true
}

HEALTHY=(); RESTARTED=(); PERSISTENT=()
for d in "$AGENTS_DIR"/*/; do
  AGENT="$(basename "$d")"
  [ -f "$d/agent-config.json" ] || continue
  if tmux has-session -t "agent-${AGENT}" 2>/dev/null; then
    HEALTHY+=("$AGENT"); write_state "$AGENT" 0; continue
  fi
  # Agent is DOWN
  CNT=$(( $(read_count "$AGENT") + 1 ))
  write_state "$AGENT" "$CNT"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: agent-${AGENT} DOWN (consecutive=$CNT), would restart"
    RESTARTED+=("$AGENT(dry)")
  else
    log "agent-${AGENT} DOWN (consecutive=$CNT) -- restarting"
    start_agent "$AGENT"
    sleep 4
    if tmux has-session -t "agent-${AGENT}" 2>/dev/null; then
      log "agent-${AGENT} restarted OK"; RESTARTED+=("$AGENT")
    else
      log "agent-${AGENT} restart FAILED (consecutive=$CNT)"
      if [ "$CNT" -ge "$ALERT_THRESHOLD" ]; then
        PERSISTENT+=("$AGENT")
        echo "$(date '+%Y-%m-%d %H:%M:%S') PERSISTENT FAILURE agent-${AGENT} ($CNT cycles)" >> "$ROOT/store/fleet-watchdog-alert.marker"
      fi
    fi
  fi
done

echo "healthy=${HEALTHY[*]:-none} restarted=${RESTARTED[*]:-none} persistent=${PERSISTENT[*]:-none}"
[ ${#PERSISTENT[@]} -gt 0 ] && exit 2
exit 0
