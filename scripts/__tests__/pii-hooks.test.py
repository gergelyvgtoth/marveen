#!/usr/bin/env python3
"""Test the PII channel hooks (scripts/hooks/pii-*.py) without Presidio.

- merge_mapping: a marker keeps its meaning for the whole session (Presidio
  numbers from _1 on every call, which used to overwrite earlier markers).
- outbound hook: rewrites the reply through hookSpecificOutput.updatedInput
  (echoing the payload back is ignored by Claude Code), reads session_id from
  stdin, and never lets SZEMELY_1 eat the prefix of SZEMELY_10.
Run:  python3 <thisfile>    Exit 0 = all pass.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
INBOUND = os.path.join(HOOKS, "pii-anonymize-inbound.py")
OUTBOUND = os.path.join(HOOKS, "pii-deanonymize-outbound.py")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check(cond, msg):
    if not cond:
        sys.stderr.write(f"FAIL: {msg}\n")
        sys.exit(1)


inbound = load(INBOUND, "pii_inbound")

# --- merge_mapping: stable markers across messages ---
existing = {}
first = inbound.merge_mapping(existing, {"SZEMELY_1": "Kovács Eszter", "EMAIL_1": "k@example.com"})
check(first == {"SZEMELY_1": "Kovács Eszter", "EMAIL_1": "k@example.com"}, f"first message: {first}")
second = inbound.merge_mapping(existing, {"SZEMELY_1": "Nagy Péter", "SZEMELY_2": "Kovács Eszter"})
check(second == {"SZEMELY_2": "Nagy Péter", "SZEMELY_1": "Kovács Eszter"}, f"second message: {second}")
check(existing["SZEMELY_1"] == "Kovács Eszter", "earlier marker was overwritten")
check(".." not in inbound.mapping_file("../../etc"), "session id path traversal")

# --- outbound hook as a subprocess ---
with tempfile.TemporaryDirectory() as tmp:
    home, proj = os.path.join(tmp, "home"), os.path.join(tmp, "proj")
    os.makedirs(os.path.join(home, ".pii-mapper", "sess-1"))
    os.makedirs(proj)
    with open(os.path.join(proj, ".env"), "w") as f:
        f.write("PII_ANONYMIZE=true\n")
    mapping = {f"SZEMELY_{i}": f"Név{i}" for i in range(1, 11)}
    mapping["EMAIL_1"] = "k@example.com"
    with open(os.path.join(home, ".pii-mapper", "sess-1", "mapping.json"), "w") as f:
        json.dump(mapping, f, ensure_ascii=False)
    env = dict(os.environ, HOME=home, CLAUDE_PROJECT_DIR=proj)

    def run(payload):
        p = subprocess.run([sys.executable, OUTBOUND], input=json.dumps(payload),
                           capture_output=True, text=True, env=env)
        check(p.returncode == 0, f"outbound exit {p.returncode}: {p.stderr}")
        return p.stdout

    out = run({"session_id": "sess-1", "tool_name": "mcp__plugin_telegram_telegram__reply",
               "tool_input": {"chat_id": "1", "text": "Kedves SZEMELY_1! SZEMELY_10 és SZEMELY_2nek: EMAIL_1"}})
    res = json.loads(out)["hookSpecificOutput"]
    check(res["hookEventName"] == "PreToolUse", f"event name: {res}")
    check(res["updatedInput"] == {"chat_id": "1", "text": "Kedves Név1! Név10 és Név2nek: k@example.com"},
          f"updatedInput: {res['updatedInput']}")

    # No marker in the text -> no output (the call goes through unchanged)
    check(run({"session_id": "sess-1", "tool_input": {"text": "semmi"}}) == "", "unchanged text produced output")
    # Unknown session -> no mapping -> no output
    check(run({"session_id": "other", "tool_input": {"text": "SZEMELY_1"}}) == "", "foreign session leaked a mapping")

    # The install-wide coordinator mapping is never used to resolve a reply:
    # its markers are numbered per call, so SZEMELY_1 there can be someone from
    # another chat (Szotasz review on #1934, item 1).
    os.makedirs(os.path.join(home, ".pii-mapper", "coordinator"))
    with open(os.path.join(home, ".pii-mapper", "coordinator", "mapping.json"), "w") as f:
        json.dump({"SZEMELY_1": "Másik Ember"}, f, ensure_ascii=False)
    check(run({"session_id": "other", "tool_input": {"text": "Kedves SZEMELY_1"}}) == "",
          "a reply was resolved from the coordinator mapping")
    out = run({"session_id": "sess-1", "tool_input": {"text": "Kedves SZEMELY_1"}})
    check(json.loads(out)["hookSpecificOutput"]["updatedInput"]["text"] == "Kedves Név1",
          "the session mapping must win, the coordinator one must not be read")

    # Per-chat coordinator mapping: K markers resolve only for the chat the
    # reply goes to, never for another chat (Szotasz review item 1).
    for cid, name in (("111", "Első Ügyfél"), ("222", "Második Ügyfél")):
        os.makedirs(os.path.join(home, ".pii-mapper", f"chat-{cid}"))
        with open(os.path.join(home, ".pii-mapper", f"chat-{cid}", "mapping.json"), "w") as f:
            json.dump({"SZEMELY_K1": name}, f, ensure_ascii=False)
    out = run({"session_id": "sess-1", "tool_input": {"chat_id": "222", "text": "Kedves SZEMELY_K1 és SZEMELY_1"}})
    check(json.loads(out)["hookSpecificOutput"]["updatedInput"]["text"] == "Kedves Második Ügyfél és Név1",
          f"chat-scoped K marker + session marker: {out}")
    check(run({"session_id": "other", "tool_input": {"chat_id": "333", "text": "SZEMELY_K1"}}) == "",
          "a K marker resolved for a chat it does not belong to")

# --- inbound hook: service down -> block AND keep the message (Szotasz review item 5) ---
with tempfile.TemporaryDirectory() as tmp:
    home, proj = os.path.join(tmp, "home"), os.path.join(tmp, "proj")
    os.makedirs(home)
    os.makedirs(proj)
    with open(os.path.join(proj, ".env"), "w") as f:
        f.write("PII_ANONYMIZE=true\n")
    env = dict(os.environ, HOME=home, CLAUDE_PROJECT_DIR=proj, PII_SERVICE_URL="http://127.0.0.1:9")
    prompt = '<channel source="plugin:telegram:telegram" chat_id="1" message_id="5">Hívd fel Teszt Elek-et</channel>'
    p = subprocess.run([sys.executable, INBOUND], input=json.dumps({"session_id": "s-9", "prompt": prompt}),
                       capture_output=True, text=True, env=env)
    check(p.returncode == 2, f"service down must block: rc={p.returncode}")
    check("NEM veszett el" in p.stderr, f"the block must say the message was kept: {p.stderr}")
    held_dir = os.path.join(home, ".pii-mapper", "held")
    held = os.listdir(held_dir)
    check(len(held) == 1, f"one held file expected: {held}")
    check(oct(os.stat(os.path.join(held_dir, held[0])).st_mode & 0o777) == "0o600", "held file must be 600")
    check(json.load(open(os.path.join(held_dir, held[0]), encoding="utf-8"))["prompt"] == prompt, "held prompt differs")

# --- the outbound matcher fires for the REAL reply tool names (Szotasz review item 4:
#     mcp__plugin_slack_slack__reply never matched; the plugin is slack-channel) ---
import re as _re
_settings = json.load(open(os.path.join(os.path.dirname(os.path.dirname(HERE)), ".claude", "settings.json"), encoding="utf-8"))
_matchers = [e["matcher"] for e in _settings["hooks"]["PreToolUse"]
             if any("pii-deanonymize-outbound.py" in h.get("command", "") for h in e.get("hooks", []))]
check(len(_matchers) == 1, f"exactly one outbound PII matcher expected: {_matchers}")
for _tool in ("mcp__plugin_telegram_telegram__reply", "mcp__plugin_telegram_telegram__edit_message",
              "mcp__plugin_slack-channel_slack__reply"):
    check(_re.fullmatch(_matchers[0], _tool) is not None, f"outbound PII matcher misses {_tool}")

print("pii-hooks: all pass")
