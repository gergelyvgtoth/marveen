# Eszköz- és csomag-sérülékenység figyelő

_Pilot-átadólap. Készült: 2026-10-29, Marveen. A tények automatikusak, a kitöltendő részeket az ágens tölti ki._

## Mit old meg
Naponta jelzi, ha egy funkcióhoz hiányzik külső program a gépről (pl. zip -> a skill-export nem működik), és hetente, ha egy éles (nem fejlesztői) csomagban komoly sérülékenység van, azzal együtt, melyik függőségünk hozza be.

## Mért hatás
2026-10-29 első futások: 16 eszköz, 2 hiány (zip, jq; mindkettő tudatosan elfogadva); 2 éles high sérülékenység (body-parser, zod a @anthropic-ai/claude-agent-sdk alól), amiről addig senki nem tudott.

## Részei (automatikus)
- `scripts/tool-deps-check.py`
  - commitok: 1, első: 27fca665 2026-10-29 feat(scripts): external-tool dependency map and runtime vulnerability check, utolsó: 27fca665 2026-10-29 feat(scripts): external-tool dependency map and runtime vulnerability check
  - Python importok: json, os, re, shutil, sys
- `scripts/dep-vuln-check.py`
  - commitok: 1, első: 27fca665 2026-10-29 feat(scripts): external-tool dependency map and runtime vulnerability check, utolsó: 27fca665 2026-10-29 feat(scripts): external-tool dependency map and runtime vulnerability check
  - Python importok: json, os, shutil, subprocess, sys
- ütemezés `tool-deps-check`: `17 7 * * *`, típus: heartbeat, ágens: marveen, aktív: True -- Napi ellenőrzés: melyik funkcióhoz hiányzik külső program a gépről
- ütemezés `dep-vuln-check`: `23 9 * * 1`, típus: heartbeat, ágens: marveen, aktív: True -- Heti ellenőrzés: komoly sérülékenység az éles csomagokban

## Külső programok (automatikus)
- `npm`: megvan
- `pip-audit`: HIÁNYZIK ezen a gépen

## Céges rendszerbe vitel
- Előfeltételek: Node/npm, Python 3; a pip-audit opcionális (telepítés engedélyhez kötött).
- Beállítás lépései: A két script és a két ütemezés (POST /api/schedules) átvétele; elfogadott hiányok a store/tool-deps-accepted.json-ban.
- Mit kell átírni (útvonalak, nevek, csatorna): ROOT útvonal; a riasztás chat_id-je az ütemezések promptjában.

## Kockázat és felügyelet
Csak jelez, javítani (npm audit fix, telepítés) emberi engedély nélkül nem javít.

## Személyes / kihagyandó rész
Nincs.
