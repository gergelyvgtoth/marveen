#!/usr/bin/env python3
"""Weekly dependency-vulnerability check, runtime packages only.

Runs `npm audit --omit=dev` (dev-only packages never run in production) and,
when the tool is installed, `pip-audit` on the PII service venv. Reports only
high/critical findings, with the direct dependency that pulls each one in, and
only the ones not already reported (store/dep-vuln-seen.json), so a known,
unfixed finding is not re-announced every week.

2026-10-29: the npm ci for v1.45.0 printed "10 vulnerabilities (3 high)" and
nobody looked; 2 of the high ones (body-parser, zod) are runtime, pulled in
through @anthropic-ai/claude-agent-sdk.

Usage: python3 scripts/dep-vuln-check.py [--json] [--mark-seen]
Exit: 0 = nothing new at high/critical, 1 = new finding(s), 2 = audit failed.
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEEN_PATH = os.path.join(ROOT, "store", "dep-vuln-seen.json")
PII_VENV_PY = os.path.join(ROOT, "scripts", "pii-service", ".venv", "bin", "python")
SEVERE = {"high", "critical"}


def npm_findings():
    proc = subprocess.run(["npm", "audit", "--json", "--omit=dev"], cwd=ROOT,
                          capture_output=True, text=True, timeout=180)
    data = json.loads(proc.stdout or "{}")
    if "vulnerabilities" not in data:
        raise RuntimeError(f"npm audit returned no report (rc={proc.returncode})")
    out = []
    for name, v in data["vulnerabilities"].items():
        if v.get("severity") not in SEVERE:
            continue
        titles = [x.get("title") for x in v.get("via", []) if isinstance(x, dict) and x.get("title")]
        fix = v.get("fixAvailable")
        out.append({
            "ecosystem": "npm",
            "package": name,
            "severity": v["severity"],
            "titles": titles,
            "fix_available": bool(fix),
            "pulled_in_by": pulled_in_by(name),
            "key": f"npm:{name}:{'|'.join(sorted(titles))}",
        })
    return out


def pulled_in_by(pkg):
    """The direct dependency that brings `pkg` in (first level of npm ls)."""
    proc = subprocess.run(["npm", "ls", pkg, "--omit=dev", "--json"], cwd=ROOT,
                          capture_output=True, text=True, timeout=60)
    try:
        deps = json.loads(proc.stdout or "{}").get("dependencies", {})
    except ValueError:
        return []
    return sorted(deps)


def pip_findings():
    if shutil.which("pip-audit") is None or not os.path.exists(PII_VENV_PY):
        return None  # not installed: reported as "skipped", never as clean
    proc = subprocess.run(["pip-audit", "--python", PII_VENV_PY, "-f", "json"],
                          capture_output=True, text=True, timeout=300)
    data = json.loads(proc.stdout or "{}")
    out = []
    for dep in data.get("dependencies", []):
        for vuln in dep.get("vulns", []):
            out.append({
                "ecosystem": "pip",
                "package": dep.get("name"),
                "severity": "unrated",  # pip-audit carries no severity; every finding is shown
                "titles": [vuln.get("id", "")],
                "fix_available": bool(vuln.get("fix_versions")),
                "pulled_in_by": ["pii-service"],
                "key": f"pip:{dep.get('name')}:{vuln.get('id')}",
            })
    return out


def load_seen():
    try:
        with open(SEEN_PATH, encoding="utf-8") as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def main():
    try:
        findings = npm_findings()
        pip = pip_findings()
    except Exception as exc:  # noqa: BLE001 -- a broken audit must say so, not look clean
        print(f"audit error: {exc}", file=sys.stderr)
        return 2
    if pip is not None:
        findings += pip
    seen = load_seen()
    new = [f for f in findings if f["key"] not in seen]
    if "--mark-seen" in sys.argv:
        with open(SEEN_PATH, "w", encoding="utf-8") as f:
            json.dump(sorted(seen | {x["key"] for x in findings}), f, indent=2)
    if "--json" in sys.argv:
        print(json.dumps({"findings": findings, "new": new, "pip_audit": "skipped" if pip is None else "ran"},
                         ensure_ascii=False, indent=2))
    else:
        print(f"{len(findings)} runtime high/critical finding(s), {len(new)} new; "
              f"pip-audit {'skipped (not installed)' if pip is None else 'ran'}")
        for f in findings:
            tag = "NEW" if f in new else "seen"
            print(f"  [{tag}] {f['ecosystem']} {f['package']} ({f['severity']}) via {', '.join(f['pulled_in_by'])}"
                  f"; fix {'available' if f['fix_available'] else 'NOT available'}: {'; '.join(f['titles'])[:120]}")
    return 1 if new else 0


if __name__ == "__main__":
    sys.exit(main())
