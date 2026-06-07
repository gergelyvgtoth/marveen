#!/bin/bash
# Independent channels watchdog (systemd --user timer, every 5 min).
#
# WHY a separate timer when the dashboard already has an in-process watchdog:
# the dashboard's watchdog dies WITH the dashboard. This timer is independent,
# so a wedged channels session is still recovered even if the dashboard process
# is down. It is the COARSE net (total-pipe-death / session-wedge); the
# dashboard's userbot inbound-probe handles the finer inbound-only deafness.
#
# Signal: store/.channel-keepalive mtime. In practice the file's only feeder is
# inbound traffic (the dashboard advances its mtime to the last ingested
# <channel> block; the historically-documented ~6-min edit_message keep-alive
# task does NOT exist as a scheduled task). So a stale file means EITHER the
# pipe is wedged/deaf OR the channel has simply been quiet. Gate 3b below
# distinguishes the two by checking whether the telegram plugin process is alive
# before respawning -- a quiet-but-healthy channel must not be respawned.
#
# Recovery: `tmux respawn-pane` of ONLY the <id>-channels pane. NEVER
# `systemctl restart` -- the tmux SERVER is shared across every agent and lives
# in the channels unit's cgroup (KillMode=control-group), so restarting the unit
# would kill the server and every agent session, not just the main one.
#
# Safety: a respawn-grace stamp prevents storming; a consecutive-respawn cap
# stops a useless respawn loop when the keepalive is disabled or the problem is
# systemic (it then alerts via the log and backs off instead).

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
KEEPALIVE_FILE="$STORE/.channel-keepalive"
RESPAWN_STAMP="$STORE/.channel-last-respawn"
RESPAWN_COUNT_FILE="$STORE/.channel-watchdog-respawns"
LOG_TAG="channel-watchdog"

STALE_SECONDS=$(( 15 * 60 ))   # keepalive older than this => wedged/deaf
GRACE_SECONDS=$(( 15 * 60 ))   # don't respawn again within this window
MAX_CONSECUTIVE=3              # after this many respawns w/o recovery, back off + alert

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*"; }

# --- resolve the channels session (launch-order / rename independent) ---
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

TMUX="$(command -v tmux)"
CLAUDE="$(command -v claude)"
if [ -z "$TMUX" ] || [ -z "$CLAUDE" ]; then
  log "tmux or claude not on PATH; cannot act. PATH=$PATH"
  exit 0
fi

now=$(date +%s)

# --- gate 1: the channels session must EXIST (bridge "running") ---
if ! "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
  log "session $SESSION not present -- systemd marveen-channels.service owns (re)start; watchdog no-op"
  exit 0
fi

# --- gate 2: keepalive file must exist (a baseline was established) ---
# If it never existed, the keep-alive task isn't running -- that's a config
# matter, not deafness; respawning won't help, so do nothing.
if [ ! -f "$KEEPALIVE_FILE" ]; then
  log "no keepalive file yet ($KEEPALIVE_FILE) -- keep-alive task not established; no-op"
  exit 0
fi

# --- gate 3: staleness ---
ka_mtime=$(stat -c %Y "$KEEPALIVE_FILE" 2>/dev/null || echo 0)
age=$(( now - ka_mtime ))
if [ "$age" -lt "$STALE_SECONDS" ]; then
  # Healthy round-trips -> reset the consecutive-respawn counter.
  rm -f "$RESPAWN_COUNT_FILE" 2>/dev/null || true
  exit 0
fi

# --- gate 3b: telegram plugin liveness (avoid false respawns of a quiet channel) ---
# The keepalive file's only feeder is inbound traffic, so a QUIET but perfectly
# healthy channel ages the file out and used to be respawned ~45x/day -- each
# respawn kills the live session and can drop an in-flight inbound message.
# Before respawning, confirm the telegram plugin (bun server.ts) is NOT alive
# under the channels pane. If it IS alive, treat the staleness as a healthy-quiet
# false positive and skip the respawn. A coarse HARD_CEILING still respawns a
# process-alive-but-pipe-wedged session as a last-resort backstop (the userbot
# inbound-probe is the intended fine-grained deafness detector).
HARD_CEILING_SECONDS=$(( 60 * 60 ))
pane_pid=$("$TMUX" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)
if [ -n "$pane_pid" ]; then
  ps_out=$(ps -axo pid,ppid,command 2>/dev/null)
  descendants="$pane_pid"; frontier="$pane_pid"
  for _ in 1 2 3 4 5 6 7 8; do
    next=$(printf '%s\n' "$ps_out" | awk -v f="$frontier" 'BEGIN{n=split(f,a," ");for(i=1;i<=n;i++)P[a[i]]=1} ($2 in P){print $1}')
    [ -z "$next" ] && break
    descendants="$descendants $next"; frontier="$next"
  done
  if printf '%s\n' "$ps_out" | awk -v d="$descendants" 'BEGIN{n=split(d,a," ");for(i=1;i<=n;i++)P[a[i]]=1} ($1 in P) && /bun server\.ts/ {f=1} END{exit !f}'; then
    if [ "$age" -lt "$HARD_CEILING_SECONDS" ]; then
      log "keepalive stale ${age}s but telegram plugin (bun server.ts) alive under pane $pane_pid -- healthy-quiet (no idle keepalive feeder); skipping respawn"
      rm -f "$RESPAWN_COUNT_FILE" 2>/dev/null || true
      exit 0
    fi
    log "keepalive stale ${age}s exceeds hard ceiling ${HARD_CEILING_SECONDS}s despite live plugin -- suspected pipe wedge, proceeding to respawn"
  fi
fi

# --- gate 4: respawn grace (shared with the dashboard watchdog) ---
if [ -f "$RESPAWN_STAMP" ]; then
  last=$(stat -c %Y "$RESPAWN_STAMP" 2>/dev/null || echo 0)
  if [ $(( now - last )) -lt "$GRACE_SECONDS" ]; then
    log "keepalive stale ${age}s but within respawn grace -- deferring"
    exit 0
  fi
fi

# --- gate 5: consecutive-respawn backoff ---
count=$(cat "$RESPAWN_COUNT_FILE" 2>/dev/null || echo 0)
case "$count" in (*[!0-9]*|'') count=0;; esac
if [ "$count" -ge "$MAX_CONSECUTIVE" ]; then
  log "ALERT: keepalive stale ${age}s after $count respawns without recovery -- backing off (keepalive disabled or systemic issue). Manual check needed: tmux attach -t $SESSION"
  exit 0
fi

# --- recover: respawn-pane ONLY the channels session, fresh claude ---
MAIN_MODEL=""
if [ -f "$INSTALL_DIR/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
  MAIN_MODEL="$(jq -r '.model // empty' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
fi
MODEL_FLAG=""
[ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model '$MAIN_MODEL' "

# Full PATH with .bun/bin -- without it the respawned bun telegram bridge does
# not come up and the session is channel-less.
RESPAWN_CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\" && $CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:telegram@claude-plugins-official"

log "keepalive stale ${age}s (>${STALE_SECONDS}s) and session up -- respawn-pane $SESSION (respawn #$((count+1)))"
if "$TMUX" respawn-pane -k -t "$SESSION" "$RESPAWN_CMD" 2>/dev/null; then
  date +%s > "$RESPAWN_STAMP"
  echo $(( count + 1 )) > "$RESPAWN_COUNT_FILE"
  log "respawn-pane issued"
else
  log "respawn-pane FAILED for $SESSION"
fi
exit 0
