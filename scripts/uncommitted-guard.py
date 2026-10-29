#!/usr/bin/env python3
"""Daily check: code that lives only in the live checkout's working tree.

2026-10-29: the channel leak gate (CHANLEAK1013) existed for two weeks only as
an uncommitted change in the live install; a stash or merge could have lost a
security rule. This lists modified tracked files and untracked files under the
code directories, minus known generated files. It never prints file content.

Exit 0 = nothing to report, 1 = something is uncommitted (the heartbeat tells
the owner), 2 = git failed.
  python3 scripts/uncommitted-guard.py
"""
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Rewritten every night / build output: expected to be dirty, never a finding.
IGNORE_EXACT = {"DREAM.md"}
IGNORE_PREFIX = ("dist.prev/", "dist/", "store/", "logs/", "node_modules/")
CODE_DIRS = ("src/", "scripts/", "web/", ".claude/", "agents/", "docs/")


def main():
    r = subprocess.run(["git", "-C", ROOT, "status", "--porcelain=v1", "--untracked-files=all"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"uncommitted-guard: git status failed: {r.stderr.strip()[:200]}")
        return 2
    modified, untracked = [], []
    for line in r.stdout.splitlines():
        code, path = line[:2], line[3:].strip().strip('"')
        if path in IGNORE_EXACT or path.startswith(IGNORE_PREFIX):
            continue
        if code == "??":
            if path.startswith(CODE_DIRS):
                untracked.append(path)
        else:
            modified.append(path)
    branch = subprocess.run(["git", "-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
    if not modified and not untracked:
        print(f"uncommitted-guard: clean ({branch})")
        return 0
    print(f"uncommitted-guard: branch {branch}, {len(modified)} modified, {len(untracked)} untracked code file(s)")
    for p in modified[:20]:
        print(f"  MODIFIED  {p}")
    for p in untracked[:20]:
        print(f"  UNTRACKED {p}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
