#!/usr/bin/env python3
"""Pilot transfer sheet: a portable description of one proven Marveen solution.

Gergely runs Marveen as a pilot for company work (Agrolánc): what proves itself
here is meant to move into the company system later. This script writes the
facts of one solution into docs/pilot/<slug>.md -- files, commits, external
programs it calls, schedule, source/licence -- and leaves the judgement
sections (what it solves, measured effect, how to move it, what is personal)
as marked placeholders for the agent to fill in.

Usage:
  python3 scripts/pilot-sheet.py <slug> --title "..." [--path P ...] [--schedule NAME ...] [--skill NAME ...]
  python3 scripts/pilot-sheet.py --index     # rebuild docs/pilot/README.md

An existing sheet is never overwritten (use a new slug, or edit it by hand).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "pilot")
SKILLS = os.path.expanduser("~/.claude/skills")
TASKS = os.path.expanduser("~/.claude/scheduled-tasks")
TODO = "_(kitöltendő)_"
CALL_RX = re.compile(r"(?:runTool|spawnSync|spawn|execFileSync|execFile|resolveFromPath|subprocess\.run|subprocess\.Popen)\(\s*\[?\s*['\"]([A-Za-z0-9._-]+)['\"]")
IMPORT_RX = re.compile(r"^(?:import|from)\s+([A-Za-z0-9_.]+)", re.M)


def git(*args, cwd=ROOT):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def describe_path(rel):
    p = os.path.join(ROOT, rel)
    lines = [f"- `{rel}`" + ("" if os.path.exists(p) else " (NINCS MEG)")]
    if not os.path.isfile(p):
        return lines, set()
    log = git("log", "--format=%h %ad %s", "--date=short", "--", rel).splitlines()
    if log:
        lines.append(f"  - commitok: {len(log)}, első: {log[-1]}, utolsó: {log[0]}")
    text = open(p, encoding="utf-8", errors="replace").read()
    tools = set(CALL_RX.findall(text))
    if rel.endswith(".py"):
        mods = sorted({m.split(".")[0] for m in IMPORT_RX.findall(text)})
        lines.append(f"  - Python importok: {', '.join(mods) or '-'}")
    return lines, tools


def describe_skill(name):
    for root in (SKILLS, os.path.join(ROOT, "agents")):
        p = os.path.join(SKILLS, name, "SKILL.md") if root == SKILLS else None
        if p and os.path.exists(p):
            text = open(p, encoding="utf-8").read()
            m = re.search(r'(?m)^description:\s*"?(.*?)"?\s*$', text)
            files = sum(len(f) for _, _, f in os.walk(os.path.dirname(p)))
            log = git("log", "--format=%h %ad %s", "--date=short", "--", name, cwd=SKILLS).splitlines()
            out = [f"- skill `{name}` ({files} fájl, globális: ~/.claude/skills/{name})",
                   f"  - leírás: {m.group(1)[:300] if m else '-'}"]
            if log:
                out.append(f"  - verziók a marveen-skills repóban: {len(log)}, utolsó: {log[0]}")
            return out
    return [f"- skill `{name}` (NEM TALÁLHATÓ)"]


def describe_schedule(name):
    cfg = os.path.join(TASKS, name, "task-config.json")
    if not os.path.exists(cfg):
        return [f"- ütemezés `{name}` (NEM TALÁLHATÓ)"]
    c = json.load(open(cfg, encoding="utf-8"))
    return [f"- ütemezés `{name}`: `{c.get('schedule')}`, típus: {c.get('type')}, ágens: {c.get('agent')}, "
            f"aktív: {c.get('enabled')} -- {c.get('description', '')}"]


def write_sheet(args):
    slug = re.sub(r"[^a-z0-9-]+", "-", args.slug.lower()).strip("-")
    out = os.path.join(OUT_DIR, f"{slug}.md")
    if os.path.exists(out):
        print(f"{out} already exists; not overwriting", file=sys.stderr)
        return 2
    facts, tools = [], set()
    for p in args.path or []:
        lines, t = describe_path(p)
        facts += lines
        tools |= t
    for s in args.skill or []:
        facts += describe_skill(s)
    for s in args.schedule or []:
        facts += describe_schedule(s)
    tool_lines = [f"- `{t}`: {'megvan' if shutil.which(t) else 'HIÁNYZIK ezen a gépen'}" for t in sorted(tools)]
    body = f"""# {args.title}

_Pilot-átadólap. Készült: {date.today().isoformat()}, Marveen. A tények automatikusak, a kitöltendő részeket az ágens tölti ki._

## Mit old meg
{TODO}

## Mért hatás
{TODO} (szám és forrás: napló, kártya, mérés; tipp nem kerülhet ide)

## Részei (automatikus)
{chr(10).join(facts) or '-'}

## Külső programok (automatikus)
{chr(10).join(tool_lines) or '- nincs kimutatható'}

## Céges rendszerbe vitel
- Előfeltételek: {TODO}
- Beállítás lépései: {TODO}
- Mit kell átírni (útvonalak, nevek, csatorna): {TODO}

## Kockázat és felügyelet
{TODO}

## Személyes / kihagyandó rész
{TODO} (Gergely magánügyei, magán-fiókok, a Marveen-személyiség)
"""
    os.makedirs(OUT_DIR, exist_ok=True)
    open(out, "w", encoding="utf-8").write(body)
    print(out)
    build_index()
    return 0


def build_index():
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = []
    for f in sorted(os.listdir(OUT_DIR)):
        if f.endswith(".md") and f != "README.md":
            first = open(os.path.join(OUT_DIR, f), encoding="utf-8").readline().lstrip("# ").strip()
            todo = open(os.path.join(OUT_DIR, f), encoding="utf-8").read().count(TODO)
            rows.append(f"| [{first}]({f}) | {'kész' if todo == 0 else f'{todo} rész kitöltendő'} |")
    open(os.path.join(OUT_DIR, "README.md"), "w", encoding="utf-8").write(
        "# Pilot-átadólapok\n\nBevált Marveen-megoldások, a céges (Agrolánc) rendszerbe vitelhez.\n\n"
        "| Megoldás | Állapot |\n|---|---|\n" + "\n".join(rows) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug", nargs="?")
    ap.add_argument("--title")
    ap.add_argument("--path", action="append")
    ap.add_argument("--skill", action="append")
    ap.add_argument("--schedule", action="append")
    ap.add_argument("--index", action="store_true")
    a = ap.parse_args()
    if a.index:
        build_index()
        return 0
    if not a.slug or not a.title:
        ap.print_help()
        return 2
    return write_sheet(a)


if __name__ == "__main__":
    sys.exit(main())
