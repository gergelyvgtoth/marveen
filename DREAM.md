# 💭 Dream Engine — 2026-05-29 02:07

## 💡 Skill-javaslatok

- **Agrolánc lead quick-entry** -- Az agrolanc agent ma 7 lead-et rögzített azonos struktúrában (ügyfél, gép, státusz, döntéshozó, piros zászlók), de nincs egységes skill ami ezt enforcolja és validálja. Javasolt: `agrolanc-lead-entry` skill. Agent: `agrolanc`.
- **Repo navigator** -- Gergely 3-szor kért GitHub repo/branch infót eltérő megfogalmazásban (melyik branch, megosztott repok, CRM repo). Érdemes egy `github-repo-navigator` skill-t csinálni ami tudja a projekt-struktúrát és gyorsan válaszol. Flotta-szintű.

## 🧹 Memória-egészség

44 / 44 memória, ebből 0 vektorizált (embedding nulla -- az embedding-job feladata, nem blokkoló).
6 hot-tier memória, egyik sem öregebb 7 napnál -- cold-mozgatás nem szükséges.
Duplikátum: 1 potenciális (Szigliget vs Szikliget önkormányzat -- agrolanc agent külön leadként kezeli, OK).
skip-skill hot memória (id: 44) -- idea-generator routine, törölhető ha zavaró.

## 🎯 Top-3 holnapi javaslat

1. gergely/marveen: NotebookLM API döntés (waiting, f6149ce8) — blokkolja a coder Tanító Tóni notebook feladatot; Gergely döntése kell, 5 perc munka.
2. mutacsi: Strukturált gép-adatbázis (f31476a0) — az agrolanc lead memóriákban 6+ különböző géptípus jelenik meg (traktor, árdaráló, fűnyíró, Robo Compact) struktúrálatlanul; az adatbázis ezt oldaná meg.
3. agrolanc: Sales-handoff formátum (c746de13) — Csaba, József, Szikliget leadek mind aktívak, de nincs egységes handoff struktúra Gergely napi pipeline összefoglalójához.

## 🌐 External opportunity

- **github.com/alirezarezvani/claude-skills** (329 skill, v2.9.0, aktív fejlesztés 2026) — átfogó Claude Code skill-könyvtár 16 domain-nel (engineering, marketing, security, productivity); érdemes átnézni van-e sales/CRM-specifikus skill amit be lehetne emelni az agrolanc flottába.

## 🛠 Skill-flotta health

18 skill indexelve, egyik sem jelölt `pinned: true`-val (nincs use-log rendszer, pontos last-used dátum nem elérhető).
Potenciálisan ritkán triggerelt skillek (kontextus alapján):
- `channel-plugin-duplicate-socket` -- nagyon specifikus Socket Mode buktató, nem látszott trigger ebben a sessionben
- `github-repo-security-audit` -- privát repó audit, utoljára nem látszott futni

Törlés NEM javasolt -- trigger-feltételük egyértelmű, csak ritkán jön elő.

---

*Marveen, 02:07 — most már alszom én is.*
