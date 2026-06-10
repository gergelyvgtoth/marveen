# 💭 Dream Engine — 2026-06-07 02:07

## 💡 Skill-javaslatok

Nincs új javaslat. Az elmúlt 24h memóriái mind infrastruktúrát érintettek (channel-wedge fix, v1.5.0 merge, workflow-recordings route) — ezek már lefedettek skillel (`heartbeat-injection-triage`, `marveen-backend-dev`, `github-pr-rebase-merge`). Nincs 3+ ismétlődő, lefedetlen manuális pattern.

## 🧹 Memória-egészség

92 memória, 84 vektorizált (8 hiányzó embedding — az embedding-job hatásköre, nem blokkoló).
5 antikvált hot-tier áthelyezve (sosem törölve):
- #45, #47 (régi dev-javaslat + lezárt napi napló) → **cold**
- #24, #25, #29 (József / Robo Compact / FJD Dynamics sales leadek) → **warm** (pipeline-kontextus, keresve maradnak, nem archívum)
Duplikátum: 0.
Új bontás: 17 hot, 48 warm, 25 cold, 2 shared.

## 🎯 Top-3 holnapi javaslat

1. **mutacsi: Strukturált gép-adatbázis + PDF extractor** (f31476a0) — alapozó kártya; a traktor-kompatibilitás kalkulátor és a sales-handoff is erre épül, érdemes ezzel kezdeni.
2. **notebooklm-integration: NotebookLM API döntés** (f6149ce8, waiting → gergely) — egyetlen döntésen áll, és blokkolja a Tanító Tóni notebook coder-feladatot (9309c489). 5 perc, nagy felszabadító hatás.
3. **mutacsi: Traktor-munkagép kompatibilitás kalkulátor** (e707b513) — a gép-adatbázisra épül, közvetlen sales-érték.

## 🌐 External opportunity

- **github.com/VoltAgent/awesome-agent-skills** — 1000+ agent skill hivatalos dev-csapatoktól (Anthropic, Stripe, Cloudflare, Vercel, Figma, Sentry) + community. Releváns: a fejlesztői flotta és a marketing/tartalom oldalra is van kész, karbantartott skill — a `skill-import` workflow-val cherry-pickelhető anélkül, hogy sajátot kéne írni. (Heti limit OK: utolsó futás 2026-05-29.)

## 🛠 Skill-flotta health

34 non-pinned skill. Nincs use-log alapú tracking, így a >30 napos antikváltság nem mérhető megbízhatóan — automatikus törlési javaslat nem indokolt. Minden skill triggere egyértelmű, manuális audit nem sürgős.

---

*Marveen, 02:07 — most már alszom én is.*
