# 💭 Dream Engine — 2026-05-30 02:07

## 💡 Skill-javaslatok

- **persistent-context-engine automatikus session-start betöltés** -- A mai implementáció (API kész, `/api/session-context/snapshot` + `/api/session-context/latest`) manuálisan hívható, de nincs automatikus trigger session induláskor. Javasolt: CLAUDE.md-be belekerül egy instrukció a context betöltésre, vagy egy `PreSessionStart` hook. Flotta-szintű.
- **upstream-pr workflow** -- Az upstream PR létrehozása (clean branch + cherry-pick + push + scope egyeztetés) ismétlődő pattern lett. A mai session során 2x kellett módosítani a scope-ot (workflow recorder utólag kerül bele). Érdemes skill-be önteni a teljes flow-t konkrét eldöntési logikával. Agent: marveen.

## 🧹 Memória-egészség

45 / 45 memória, ebből 0 vektorizált (embedding-job feladata, nem blokkoló).
7 hot-tier memória, mind friss (7 napon belül) -- cold-mozgatás nem szükséges.
Duplikátum: 0.
Kategória-bontás: 7 hot, 33 warm, 4 cold, 1 shared.

## 🎯 Top-3 holnapi javaslat

1. **marveen: Persistent Context Engine automatikus CLAUDE.md integráció** -- A mai implementáció manuálisan hívható; a teljes értékét akkor adja, ha session indításkor automatikusan betöltődik. Gergely már jóváhagyta (msg 529), csak a CLAUDE.md instrukció hiányzik.
2. **notebooklm-integration: NotebookLM API döntés** (f6149ce8) -- waiting, Gergely döntése kell. 5 perc munka, de blokkolja a Tanító Tóni coder feladatot (9309c489).
3. **upstream-pr: PR megnyitása Szotasz/marveen felé** -- az upstream-pr branch kész, 10 commit várakozik. Csak `gh pr create` parancs kell Gergelytől (URL már elküldve).

## 🌐 External opportunity

- **github.com/BuilderIO/micro-agent** -- Micro-task alapú AI agent framework, amely kis lépésekben végrehajt és validál feladatokat (TDD-alapú). Releváns: a Marveen agent fleet jelenleg monolitikus task-okat futtat; micro-agent mintával a hibás lépések hamarabb derülnek ki és könnyebben recovery-zhetők. Stars: 3.2k, aktív fejlesztés 2026.

## 🛠 Skill-flotta health

24 skill indexelve. Új (mai session): `persistent-context-engine`, `github-repo-watch`, `workflow-management`.
Potenciálisan ritkán triggerelt:
- `channel-plugin-duplicate-socket` -- Socket Mode-specifikus buktató, ritkán releváns
- `notebooklm` -- csak NotebookLM integráció esetén, jelenleg waiting

Törlés NEM javasolt -- trigger-feltételük egyértelmű, ritkán jön elő.

---

*Marveen, 02:07 — most már alszom én is.*
