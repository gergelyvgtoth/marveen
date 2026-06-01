#!/bin/bash
# Marveen safe deploy: build -> restart systemd service -> health-check -> rollback on failure.
#
# Usage: bash scripts/deploy.sh
#
# Requires the `marveen` systemd --user service (see ~/.config/systemd/user/marveen.service).
# Keeps dist.prev as last-known-good so a failed deploy auto-reverts.

set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd -P)"
HEALTH_URL="http://localhost:3420/"
SERVICE="marveen"
TIMEOUT=25

say() { echo "[deploy] $*"; }

# 1. Build. Abort BEFORE touching the running service if it fails.
say "Building (tsc)..."
if ! npx tsc 2>&1; then
  say "BUILD FAILED -- running service untouched. Aborting."
  exit 1
fi

# 1b. Regression gate: refuse to promote if a scenario regressed vs baseline.
# Runs against the still-running (old) backend's API. A non-zero exit blocks.
say "Regression gate..."
if ! bash scripts/regression-check.sh; then
  say "REGRESSION GATE FAILED -- not deploying. Running service untouched."
  exit 1
fi

# 2. Snapshot current dist as rollback point.
if [ -d dist ]; then
  rm -rf dist.prev
  cp -r dist dist.prev
  say "Snapshotted dist -> dist.prev"
fi

restart_and_check() {
  systemctl --user restart "$SERVICE"
  local i
  for i in $(seq 1 $TIMEOUT); do
    if curl -fs -o /dev/null "$HEALTH_URL" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# 3. Restart + health-check.
say "Restarting service + health-checking ${HEALTH_URL}..."
if restart_and_check; then
  say "HEALTHY. Deploy OK."
  exit 0
fi

# 4. Rollback.
say "UNHEALTHY after ${TIMEOUT}s. Rolling back to dist.prev..."
if [ -d dist.prev ]; then
  rm -rf dist
  cp -r dist.prev dist
  if restart_and_check; then
    say "Rolled back and HEALTHY. Deploy aborted (old code restored)."
    exit 2
  fi
  say "ROLLBACK ALSO UNHEALTHY -- manual intervention needed. Check: journalctl --user -u ${SERVICE} / store/marveen-service.log"
  exit 3
fi
say "No dist.prev to roll back to. Service may be down."
exit 3
