#!/usr/bin/env python3
"""External-program dependency map: which features call which binaries, and
which of those binaries are missing on this host right now.

2026-10-29: `zip` was missing, so the dashboard skill export was broken in
production; it surfaced only because 21 unrelated tests failed. This scan
makes that kind of gap visible the day it appears.

Usage:
  python3 scripts/tool-deps-check.py           # human report
  python3 scripts/tool-deps-check.py --json    # machine-readable
Exit code: 0 = nothing NEW missing, 1 = a missing tool that is not in the
accepted list (store/tool-deps-accepted.json), 2 = scan error.
"""
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
ACCEPTED_PATH = os.path.join(ROOT, "store", "tool-deps-accepted.json")

CALL_RX = re.compile(
    r"(?:runTool|spawnSync|spawn|execFileSync|execFile|resolveFromPath)\(\s*['\"]([A-Za-z0-9._-]+)['\"]")
# Words that the call regex catches but are not programs (state names, labels).
NOT_PROGRAMS = {"typing", "idle", "busy", "error", "unknown", "which"}
# Used outside src/ (skills, scripts, hooks) and worth tracking.
EXTRA = {
    "gh": "GitHub-figyelők (upstream/PR watch), repo-audit skill",
    "sqlite3": "kézi DB-lekérdezések a skillekben (python3 a fallback)",
    "jq": "JSON-feldolgozás egyes scriptekben (python3 a fallback)",
    "curl": "minden dashboard API-hívás a skillekben",
}


def scan_src():
    uses = {}
    for dirpath, dirnames, filenames in os.walk(SRC):
        if "__tests__" in dirpath:
            continue
        for fn in filenames:
            if not fn.endswith(".ts"):
                continue
            path = os.path.join(dirpath, fn)
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            for m in CALL_RX.finditer(text):
                prog = m.group(1)
                if prog in NOT_PROGRAMS:
                    continue
                uses.setdefault(prog, set()).add(os.path.relpath(path, ROOT))
    return uses


def load_accepted():
    try:
        with open(ACCEPTED_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if isinstance(v, str)}
    except (OSError, ValueError):
        return {}


def main():
    as_json = "--json" in sys.argv
    try:
        uses = scan_src()
    except Exception as exc:  # noqa: BLE001 -- report, never crash the heartbeat
        print(f"scan error: {exc}", file=sys.stderr)
        return 2
    accepted = load_accepted()
    rows = []
    for prog in sorted(set(uses) | set(EXTRA)):
        present = shutil.which(prog) is not None
        rows.append({
            "tool": prog,
            "present": present,
            "used_in": sorted(uses.get(prog, [])),
            "note": EXTRA.get(prog, ""),
            "accepted_missing": accepted.get(prog) if not present else None,
        })
    missing = [r for r in rows if not r["present"]]
    new_missing = [r for r in missing if not r["accepted_missing"]]
    if as_json:
        print(json.dumps({"tools": rows, "missing": [r["tool"] for r in missing],
                          "new_missing": [r["tool"] for r in new_missing]}, ensure_ascii=False, indent=2))
    else:
        print(f"{len(rows)} external tools tracked, {len(missing)} missing, {len(new_missing)} new")
        for r in missing:
            where = ", ".join(r["used_in"][:4]) or r["note"]
            tag = f"ACCEPTED ({r['accepted_missing']})" if r["accepted_missing"] else "NEW"
            print(f"  MISSING {r['tool']:<12} [{tag}] used in: {where}")
    return 1 if new_missing else 0


if __name__ == "__main__":
    sys.exit(main())
