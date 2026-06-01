#!/bin/bash
# Marveen regression gate: compares each scenario's newest candidate recording
# against its baseline via the session-replay API. Exits non-zero if any
# scenario shows a regression, so deploy.sh can refuse to promote.
#
# Scope: gates STORED candidate recordings (golden-test style). Auto-capturing
# a fresh candidate from the live agent is a future layer; until then, capture
# a candidate recording after a change and mark a baseline per scenario.
#
# Requires the backend to be running (uses its API). Uses python3, not jq.
set -u
cd "$(dirname "$0")/.." || exit 1
BASE="http://localhost:3420"
TOKEN="$(cat store/.dashboard-token 2>/dev/null)"

curl -fs -H "Authorization: Bearer $TOKEN" "$BASE/api/session-recordings" 2>/dev/null | \
TOKEN="$TOKEN" BASE="$BASE" python3 -c '
import sys, json, os, urllib.request

try:
    recs = json.load(sys.stdin)
except Exception:
    print("[regression-check] could not read recordings (backend down?) -- skipping gate")
    sys.exit(0)

base, token = os.environ["BASE"], os.environ["TOKEN"]
by_scenario = {}
for r in recs:
    by_scenario.setdefault(r["scenario"], []).append(r)

def compare(baseline_id, candidate_id):
    body = json.dumps({"baselineId": baseline_id, "candidateId": candidate_id}).encode()
    req = urllib.request.Request(base + "/api/session-recordings/compare", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)

gated = 0
regressions = []
for scenario, rs in by_scenario.items():
    baseline = next((r for r in rs if r.get("is_baseline")), None)
    cands = [r for r in rs if not r.get("is_baseline")]
    if not baseline or not cands:
        continue
    candidate = max(cands, key=lambda r: r["created_at"])
    gated += 1
    try:
        res = compare(baseline["id"], candidate["id"])
        diff = res.get("diff", {})
        if diff.get("isRegression"):
            regressions.append((scenario, diff.get("summary", "")))
    except Exception as e:
        print(f"[regression-check] compare failed for {scenario}: {e}")

if not gated:
    print("[regression-check] no scenarios with baseline+candidate -- nothing to gate, PASS")
    sys.exit(0)
if regressions:
    print(f"[regression-check] {len(regressions)} REGRESSZIO {gated} szcenariobol:")
    for s, summ in regressions:
        print(f"  - {s}: {summ}")
    sys.exit(1)
print(f"[regression-check] {gated} szcenario ellenorizve, nincs regresszio. PASS")
sys.exit(0)
'
