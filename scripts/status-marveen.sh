#!/bin/bash
# Marveen rendszer státusz lekérdezése
# Szép, színes kimenet ANSI kódokkal

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ANSI színek
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

OK="${GREEN}✓${RESET}"
FAIL="${RED}✗${RESET}"
WARN="${YELLOW}!${RESET}"

echo ""
echo -e "${BOLD}${CYAN}══════════════════════════════════════${RESET}"
echo -e "${BOLD}${CYAN}  Marveen Rendszer Státusz${RESET}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════${RESET}"
echo ""

# ──────────────────────────────────────────
# 1. Dashboard státusz
# ──────────────────────────────────────────
echo -e "${BOLD}[ Dashboard ]${RESET}"

DASHBOARD_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)

if [ -n "$DASHBOARD_PID" ]; then
  echo -e "  $OK Processz fut (PID: ${DASHBOARD_PID})"

  # Uptime (Linux: ps -o etime)
  UPTIME=$(ps -o etime= -p "$DASHBOARD_PID" 2>/dev/null | tr -d ' ')
  [ -n "$UPTIME" ] && echo -e "     Uptime: ${UPTIME}"

  # HTTP elérhetőség
  HTTP_STATUS=$(curl -sI http://localhost:3420 2>/dev/null | head -1 | tr -d '\r')
  if echo "$HTTP_STATUS" | grep -q "200\|301\|302"; then
    echo -e "  $OK HTTP elérhető (${HTTP_STATUS})"
  else
    echo -e "  $FAIL HTTP nem válaszol: ${HTTP_STATUS:-nincs válasz}"
  fi
else
  echo -e "  $FAIL Processz nem fut"
  echo -e "  $FAIL HTTP nem elérhető"
fi

echo ""

# ──────────────────────────────────────────
# 2. Tmux session-ök
# ──────────────────────────────────────────
echo -e "${BOLD}[ Tmux session-ök ]${RESET}"

TMUX_LIST=$(tmux ls 2>/dev/null)
if [ -z "$TMUX_LIST" ]; then
  echo -e "  $WARN Nincs futó tmux session"
else
  while IFS= read -r LINE; do
    SESSION_NAME=$(echo "$LINE" | awk -F: '{print $1}')
    SESSION_INFO=$(echo "$LINE" | sed 's/^[^:]*: //')
    echo -e "  $OK ${BOLD}${SESSION_NAME}${RESET}: ${SESSION_INFO}"
  done <<< "$TMUX_LIST"
fi

echo ""

# ──────────────────────────────────────────
# 3. Adatbázis statisztikák
# ──────────────────────────────────────────
echo -e "${BOLD}[ Adatbázis ]${RESET}"

DB="$INSTALL_DIR/store/claudeclaw.db"
if [ ! -f "$DB" ]; then
  echo -e "  $FAIL Adatbázis nem található: $DB"
else
  # Memóriák
  MEM_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "?")
  echo -e "  $OK Memóriák: ${BOLD}${MEM_COUNT}${RESET} db"

  # Kanban kártyák státusz szerint
  KANBAN=$(sqlite3 "$DB" "SELECT status, COUNT(*) FROM kanban_cards GROUP BY status;" 2>/dev/null)
  if [ -n "$KANBAN" ]; then
    echo -e "  $OK Kanban kártyák:"
    while IFS='|' read -r STATUS COUNT; do
      case "$STATUS" in
        done)        COLOR="$GREEN" ;;
        in_progress) COLOR="$YELLOW" ;;
        planned)     COLOR="$BLUE" ;;
        *)           COLOR="$RESET" ;;
      esac
      echo -e "     ${COLOR}${STATUS}${RESET}: ${COUNT}"
    done <<< "$KANBAN"
  else
    echo -e "  $WARN Kanban: nincs adat"
  fi

  # Utolsó 5 task_run
  TASK_RUNS=$(sqlite3 "$DB" "SELECT id, agent_id, status, started_at FROM task_runs ORDER BY rowid DESC LIMIT 5;" 2>/dev/null)
  if [ -n "$TASK_RUNS" ]; then
    echo -e "  $OK Utolsó 5 task run:"
    while IFS='|' read -r ID AGENT STATUS STARTED; do
      case "$STATUS" in
        completed) COLOR="$GREEN" ;;
        failed)    COLOR="$RED" ;;
        running)   COLOR="$YELLOW" ;;
        *)         COLOR="$RESET" ;;
      esac
      echo -e "     ${COLOR}${STATUS}${RESET} | ${AGENT} | ${STARTED} | ${ID:0:16}..."
    done <<< "$TASK_RUNS"
  else
    echo -e "  $WARN Task runs: nincs adat"
  fi
fi

echo ""

# ──────────────────────────────────────────
# 4. Telegram bot tokenek / agent-channel párosítás
# ──────────────────────────────────────────
echo -e "${BOLD}[ Telegram bot párosítások ]${RESET}"

# Fő agent
MAIN_TOKEN_FILE="$HOME/.claude/channels/telegram/.env"
if [ -f "$MAIN_TOKEN_FILE" ]; then
  BOT_TOKEN=$(grep "TELEGRAM_BOT_TOKEN" "$MAIN_TOKEN_FILE" 2>/dev/null | cut -d= -f2- | head -1)
  if [ -n "$BOT_TOKEN" ]; then
    BOT_ID=$(echo "$BOT_TOKEN" | cut -d: -f1)
    echo -e "  $OK marveen (fő): bot ID ${BOLD}${BOT_ID}${RESET}"
  fi
fi

# Sub-agensek
if [ -d "$INSTALL_DIR/agents" ]; then
  for AGENT_DIR in "$INSTALL_DIR/agents"/*/; do
    AGENT_ID=$(basename "$AGENT_DIR")
    AGENT_TOKEN_FILE="$HOME/.claude/channels/telegram-${AGENT_ID}/.env"
    if [ -f "$AGENT_TOKEN_FILE" ]; then
      BOT_TOKEN=$(grep "TELEGRAM_BOT_TOKEN" "$AGENT_TOKEN_FILE" 2>/dev/null | cut -d= -f2- | head -1)
      if [ -n "$BOT_TOKEN" ]; then
        BOT_ID=$(echo "$BOT_TOKEN" | cut -d: -f1)
        echo -e "  $OK ${AGENT_ID}: bot ID ${BOLD}${BOT_ID}${RESET}"
      else
        echo -e "  $WARN ${AGENT_ID}: token fájl van, de üres"
      fi
    else
      echo -e "  $WARN ${AGENT_ID}: nincs token fájl ($AGENT_TOKEN_FILE)"
    fi
  done
fi

# access.json ellenőrzés (fallback)
ACCESS_JSON="$HOME/.claude/channels/telegram/access.json"
if [ -f "$ACCESS_JSON" ]; then
  USER_COUNT=$(python3 -c "import json,sys; d=json.load(open('$ACCESS_JSON')); print(len(d.get('allowlist',[])))" 2>/dev/null || echo "?")
  echo -e "  $OK Telegram allowlist: ${USER_COUNT} engedélyezett felhasználó"
fi

echo ""

# ──────────────────────────────────────────
# 5. Diszk hely
# ──────────────────────────────────────────
echo -e "${BOLD}[ Diszk ]${RESET}"

STORE_SIZE=$(du -sh "$INSTALL_DIR/store/" 2>/dev/null | awk '{print $1}')
LOGS_SIZE=$(du -sh "$INSTALL_DIR/logs/" 2>/dev/null | awk '{print $1}')
echo -e "  $OK store/: ${BOLD}${STORE_SIZE:-?}${RESET}"
echo -e "  $OK logs/:  ${BOLD}${LOGS_SIZE:-?}${RESET}"

echo ""
echo -e "${BOLD}${CYAN}══════════════════════════════════════${RESET}"
echo ""

exit 0
