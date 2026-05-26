#!/bin/bash
# Marveen + összes agent indítása
# Idempotens: biztonságosan futtatható többször egymás után

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

# Logok mappa
mkdir -p "$INSTALL_DIR/logs"

echo "======================================"
echo "  Marveen rendszer indítása"
echo "======================================"
echo ""

# ──────────────────────────────────────────
# 1. Dashboard backend
# ──────────────────────────────────────────
echo "[ Dashboard ]"
DASHBOARD_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)

if [ -n "$DASHBOARD_PID" ]; then
  echo "  ✓ Dashboard már fut (PID: $DASHBOARD_PID)"
else
  echo "  → Dashboard indítása..."
  cd "$INSTALL_DIR" && nohup npm start > "$INSTALL_DIR/logs/dashboard.log" 2>&1 &
  sleep 5

  # Elérhetőség ellenőrzése
  HTTP_STATUS=$(curl -sI http://localhost:3420 2>/dev/null | head -1)
  if echo "$HTTP_STATUS" | grep -q "200\|301\|302"; then
    NEW_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
    echo "  ✓ Dashboard elindult (PID: ${NEW_PID:-?})"
  else
    echo "  ✗ Dashboard nem válaszol HTTP-n! Logok: $INSTALL_DIR/logs/dashboard.log"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""

# ──────────────────────────────────────────
# 2. Fő agent (marveen-channels)
# ──────────────────────────────────────────
echo "[ Fő agent: marveen ]"
if tmux has-session -t "marveen-channels" 2>/dev/null; then
  echo "  ✓ marveen-channels már fut"
else
  echo "  → marveen-channels indítása..."
  if [ -x "$INSTALL_DIR/scripts/channels.sh" ]; then
    nohup "$INSTALL_DIR/scripts/channels.sh" > "$INSTALL_DIR/logs/marveen-channels.log" 2>&1 &
    sleep 3
    if tmux has-session -t "marveen-channels" 2>/dev/null; then
      echo "  ✓ marveen-channels elindult"
    else
      echo "  ✗ marveen-channels nem indult el! Logok: $INSTALL_DIR/logs/marveen-channels.log"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "  ✗ channels.sh nem található vagy nem futtatható"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""

# ──────────────────────────────────────────
# 3. Sub-agensek (agents/ mappa)
# ──────────────────────────────────────────
echo "[ Sub-agensek ]"

if [ ! -d "$INSTALL_DIR/agents" ]; then
  echo "  (nincs agents/ mappa)"
else
  TOKEN=""
  if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
    TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")
  fi

  CLAUDE_BIN="$(command -v claude)"
  if [ -z "$CLAUDE_BIN" ]; then
    export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
    CLAUDE_BIN="$(command -v claude)"
  fi

  for AGENT_DIR in "$INSTALL_DIR/agents"/*/; do
    AGENT_ID=$(basename "$AGENT_DIR")
    SESSION_NAME="agent-${AGENT_ID}"

    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      echo "  ✓ $AGENT_ID már fut (session: $SESSION_NAME)"
      continue
    fi

    echo "  → $AGENT_ID indítása..."

    # Token és model az agent config-ból
    CHAN_DIR="$AGENT_DIR/.claude/channels/telegram"
    BOT_TOKEN=$(grep "TELEGRAM_BOT_TOKEN" "$CHAN_DIR/.env" 2>/dev/null | cut -d= -f2- | head -1)
    MODEL=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/agent-config.json')); print(d.get('model','claude-opus-4-7'))" 2>/dev/null || echo "claude-opus-4-7")

    if [ -z "$BOT_TOKEN" ]; then
      echo "  ✗ $AGENT_ID: nincs bot token ($CHAN_DIR/.env)"
      ERRORS=$((ERRORS + 1))
      continue
    fi

    # Közvetlen tmux indítás --continue nélkül (elkerüli a "No deferred tool marker" hibát)
    CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export TELEGRAM_STATE_DIR=\"$CHAN_DIR\" && cd \"$AGENT_DIR\" && ${CLAUDE_BIN} --dangerously-skip-permissions --model $MODEL --channels plugin:telegram@claude-plugins-official"

    tmux new-session -d -s "$SESSION_NAME" "$CMD" 2>/dev/null
    sleep 2

    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      echo "  ✓ $AGENT_ID elindult (session: $SESSION_NAME)"
    else
      echo "  ✗ $AGENT_ID nem indult el"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

echo ""
echo "======================================"

if [ "$ERRORS" -eq 0 ]; then
  echo "  ✓ Minden komponens rendben"
  exit 0
else
  echo "  ✗ $ERRORS hiba fordult elő az indítás során"
  exit 1
fi
