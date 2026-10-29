# Skill-import csővezeték (letöltés, átvizsgálás, telepítés)

_Pilot-átadólap. Készült: 2026-10-29, Marveen. A tények automatikusak, a kitöltendő részeket az ágens tölti ki._

## Mit old meg
Külső (GitHub) skill behozatala úgy, hogy előbb elkülönített helyre töltődik, a gép átvizsgálja (rejtett karakter, injekció-szerű szöveg, titok, hálózatot/programot indító scriptek, letöltő-indítók), és csak átnézés + adaptálás után kerül az ágensekhez.

## Mért hatás
2026-10-29: 4 import kézzel (marketingskills 5, superpowers 6, humanizer, ui-ux-pro-max) kb. 15 lépés/import volt; a pipeline ezt 2 parancsra rövidíti. Az impeccable letöltő-indítóját automatikusan BLOCK-kal megállította (próba 2026-10-29 18:20).

## Részei (automatikus)
- skill `skill-import` (4 fájl, globális: ~/.claude/skills/skill-import)
  - leírás: Külső GitHub skill repóból (pl. alirezarezvani/claude-skills) releváns skill-ek azonosítása, letöltése és Marveen-formátumra adaptálása. Trigger: Gergely küld egy skill repó URL-t és azt mondja "nézzük meg / tegyük bele".
  - verziók a marveen-skills repóban: 4, utolsó: d178a45 2026-10-29 skills: skill-import pipeline script (stage/review/install) + docs

## Külső programok (automatikus)
- nincs kimutatható

## Céges rendszerbe vitel
- Előfeltételek: gh CLI bejelentkezve, Python 3 + PyYAML, a skill-gyökér git-repóként (mentéshez).
- Beállítás lépései: A ~/.claude/skills/skill-import mappa (SKILL.md + scripts/import-skill.py, import-pipeline.py, scan-skills.py) átmásolása; INDEX_SCRIPT és a push-cél (origin) átírása.
- Mit kell átírni (útvonalak, nevek, csatorna): INDEX_SCRIPT útvonal, a skill-repó remote-ja, a magyar description-szabály a céges nyelvre.

## Kockázat és felügyelet
A szkennelés triázs, nem garancia: a jelzett scripteket embernek/ágensnek el kell olvasnia. A script maga tartalmazza a titok-regexet, ezért a saját változásainál a titok-szűrő hamis pozitív.

## Személyes / kihagyandó rész
Nincs.
