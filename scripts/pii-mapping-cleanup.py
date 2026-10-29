#!/usr/bin/env python3
"""Retention for the PII marker mappings (~/.pii-mapper/<session>/mapping.json).

The mapping files are the one place that holds every original value the PII
hooks replaced, and nothing removed them (Szotasz review on #1934, item 6;
on this install they had piled up since 2026-10-13). This deletes a session's
mapping directory once nothing in it changed for PII_MAPPING_RETENTION_DAYS.

PII_MAPPING_RETENTION_DAYS (process env first, then the project .env):
  unset      -> 365 days (Gergely, 2026-10-29)
  N > 0      -> N days
  0 / off    -> keep everything (e.g. a sales user who needs the names later)

After deletion a marker in an old conversation can no longer be turned back
into the name; that is the trade-off the setting controls.

Never prints a mapping's content, only counts. Exit 0 always (a monitor).
  python3 scripts/pii-mapping-cleanup.py [--dry-run]
"""
import json
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DAYS = 365
WARN_FRACTION = 0.9
STATE_DIR = os.environ.get("PII_RETENTION_STATE_DIR") or os.path.join(ROOT, "store")
HOLDS_PATH = os.path.join(STATE_DIR, "pii-retention-holds.json")
WARNED_PATH = os.path.join(STATE_DIR, "pii-retention-warned.json")


def retention_days():
    raw = os.environ.get("PII_MAPPING_RETENTION_DAYS")
    if raw is None:
        try:
            with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
                for line in f:
                    if line.strip().startswith("PII_MAPPING_RETENTION_DAYS="):
                        raw = line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    if raw is None or raw == "":
        return DEFAULT_DAYS
    if raw.lower() in ("0", "off", "false", "no"):
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_DAYS


def newest_mtime(d):
    m = os.path.getmtime(d)
    for root, _, files in os.walk(d):
        for f in files:
            try:
                m = max(m, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return m


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def entry_count(d):
    m = load_json(os.path.join(d, "mapping.json"), {})
    return len(m) if isinstance(m, dict) else 0


def day(ts):
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def main(argv):
    dry = "--dry-run" in argv
    base = os.path.expanduser("~/.pii-mapper")
    if "--hold" in argv:
        # The owner said "keep this": a held package is never deleted or warned about again.
        names = argv[argv.index("--hold") + 1:]
        holds = load_json(HOLDS_PATH, {})
        for n in names:
            holds[n] = time.strftime("%Y-%m-%d")
        save_json(HOLDS_PATH, holds)
        print(f"pii-mapping-cleanup: held {len(names)}: {', '.join(names)}")
        return 0
    days = retention_days()
    if days == 0:
        print("pii-mapping-cleanup: retention off (PII_MAPPING_RETENTION_DAYS=0), nothing deleted")
        return 0
    if not os.path.isdir(base):
        print("pii-mapping-cleanup: no mapping dir")
        return 0
    now = time.time()
    cutoff = now - days * 86400
    # Owner request 2026-10-29: warn at 90 % of the retention period (one year
    # -> ~37 days ahead, ten days -> one day ahead), so a package can be kept.
    warn_from = now - days * WARN_FRACTION * 86400
    holds = load_json(HOLDS_PATH, {})
    warned = load_json(WARNED_PATH, {})
    kept = removed = held = 0
    for name in sorted(os.listdir(base)):
        d = os.path.join(base, name)
        if not os.path.isdir(d) or os.path.islink(d):
            continue
        if name in holds:
            held += 1
            continue
        last = newest_mtime(d)
        warned_at = warned.get(name)
        # Delete only a package the owner was warned about at least a day
        # before (the warning names the deletion day); otherwise warn first.
        if last < cutoff and isinstance(warned_at, (int, float)) and now - warned_at >= 86400:
            if not dry:
                shutil.rmtree(d, ignore_errors=True)
                warned.pop(name, None)
            removed += 1
            continue
        kept += 1
        if last < warn_from and not warned.get(name):
            deletes_on = max(last + days * 86400, now + 86400)
            print(f"WARN {name} last_used {day(last)} entries {entry_count(d)} deletes_on {day(deletes_on)}")
            if not dry:
                warned[name] = now
    if not dry:
        save_json(WARNED_PATH, warned)
    verb = "would remove" if dry else "removed"
    print(f"pii-mapping-cleanup: retention {days} d, {verb} {removed}, kept {kept}, held {held}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
