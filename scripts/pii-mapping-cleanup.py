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
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DAYS = 365


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


def main(argv):
    dry = "--dry-run" in argv
    base = os.path.expanduser("~/.pii-mapper")
    days = retention_days()
    if days == 0:
        print("pii-mapping-cleanup: retention off (PII_MAPPING_RETENTION_DAYS=0), nothing deleted")
        return 0
    if not os.path.isdir(base):
        print("pii-mapping-cleanup: no mapping dir")
        return 0
    cutoff = time.time() - days * 86400
    kept = removed = 0
    for name in sorted(os.listdir(base)):
        d = os.path.join(base, name)
        if not os.path.isdir(d) or os.path.islink(d):
            continue
        if newest_mtime(d) < cutoff:
            if not dry:
                shutil.rmtree(d, ignore_errors=True)
            removed += 1
        else:
            kept += 1
    verb = "would remove" if dry else "removed"
    print(f"pii-mapping-cleanup: retention {days} d, {verb} {removed}, kept {kept}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
