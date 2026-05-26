#!/bin/bash
# Marveen + összes agent leállítása
# Idempotens: biztonságosan futtatható többször egymás után

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

echo "======================================"
echo "  Marveen rendszer leállítása"
echo "======================================"
echo ""

# ──────────────────────────────────────────
# 1. Összes agent- és *-channels tmux session
# ──────────────────────────────────────────
echo "[ Tmux session-ök leállítása ]"

SESSIONS=$(tmux ls 2>/dev/null | awk -F: '{print $1}')
if [ -z "$SESSIONS" ]; then
  echo "  (nincs futó tmux session)"
else
  while IFS= read -r SESSION; do
    if echo "$SESSION" | grep -qE '^agent-|channels$'; then
      tmux kill-session -t "$SESSION" 2>/dev/null
      echo "  ✓ Leállítva: $SESSION"
    fi
  done <<< "$SESSIONS"
fi

echo ""

# ──────────────────────────────────────────
# 2. Dashboard backend
# ──────────────────────────────────────────
echo "[ Dashboard leállítása ]"

DASHBOARD_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
if [ -n "$DASHBOARD_PID" ]; then
  pkill -f "node dist/index.js" 2>/dev/null
  sleep 2

  # Ellenőrzés
  STILL_RUNNING=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
  if [ -z "$STILL_RUNNING" ]; then
    echo "  ✓ Dashboard leállt"
  else
    echo "  ✗ Dashboard még fut (PID: $STILL_RUNNING) -- erőltetett leállítás..."
    kill -9 "$STILL_RUNNING" 2>/dev/null
    echo "  ✓ SIGKILL elküldve"
  fi
else
  echo "  (Dashboard nem fut)"
fi

echo ""

# ──────────────────────────────────────────
# 3. PID lock fájl takarítás
# ──────────────────────────────────────────
echo "[ Takarítás ]"

PID_FILE="$INSTALL_DIR/store/claudeclaw.pid"
if [ -f "$PID_FILE" ]; then
  rm -f "$PID_FILE"
  echo "  ✓ PID lock fájl eltávolítva"
else
  echo "  (nincs PID lock fájl)"
fi

echo ""
echo "======================================"

if [ "$ERRORS" -eq 0 ]; then
  echo "  ✓ Minden komponens tisztán leállt"
  exit 0
else
  echo "  ✗ $ERRORS hiba fordult elő a leállítás során"
  exit 1
fi
