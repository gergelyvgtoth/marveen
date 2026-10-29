#!/usr/bin/env python3
"""Hand back channel messages the PII inbound hook held while the service was down.

pii-anonymize-inbound.py blocks a prompt (exit 2) when the PII service is
unreachable; it now first saves the prompt under ~/.pii-mapper/held/ (Szotasz
review on #1934, item 5: blocking used to erase the message). Once the service
answers /health again, this script queues every held prompt to the main agent
through the dashboard message API; the delivered prompt passes the inbound hook
again, this time filtered. A held file is removed only after the API accepted it.

Never prints message content, only counts. Exit 0 always (a monitor).
  python3 scripts/pii-held-redeliver.py
"""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELD_DIR = os.path.join(os.path.expanduser("~/.pii-mapper"), "held")
SERVICE_URL = "http://127.0.0.1:5200"
API = os.environ.get("MARVEEN_API", "http://localhost:3420")
TOKEN_FILE = os.path.join(ROOT, "store", ".dashboard-token")
AGENT = os.environ.get("MAIN_AGENT_ID", "marveen")


def service_up():
    try:
        urllib.request.urlopen(f"{SERVICE_URL}/health", timeout=3)
        return True
    except Exception:
        return False


def post_message(content):
    token = open(TOKEN_FILE, encoding="utf-8").read().strip()
    body = json.dumps({"from": AGENT, "to": AGENT, "content": content}).encode("utf-8")
    req = urllib.request.Request(f"{API}/api/messages", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return 200 <= r.status < 300


def main():
    if not os.path.isdir(HELD_DIR):
        print("pii-held-redeliver: nothing held")
        return 0
    files = sorted(f for f in os.listdir(HELD_DIR) if f.endswith(".json"))
    if not files:
        print("pii-held-redeliver: nothing held")
        return 0
    if not service_up():
        print(f"pii-held-redeliver: {len(files)} held, PII service still down -- waiting")
        return 0
    sent = failed = 0
    for f in files:
        path = os.path.join(HELD_DIR, f)
        try:
            held = json.load(open(path, encoding="utf-8"))
            content = ("[UJRAKEZBESITES PII] Ez a csatorna-uzenet a PII-szuro kiesese miatt nem jutott el hozzad "
                       "(felretett uzenet). Dolgozd fel most a szokott modon, es valaszolj a csatornan:\n\n" + held["prompt"])
            if post_message(content):
                os.remove(path)
                sent += 1
            else:
                failed += 1
        except Exception:
            failed += 1
    print(f"pii-held-redeliver: redelivered {sent}, failed {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
