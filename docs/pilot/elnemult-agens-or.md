# Elnémult ágens őr (bejelentkezés-lejárat észlelés és újraindítás)

_Pilot-átadólap. Készült: 2026-10-29, Marveen. A tények automatikusak, a kitöltendő részeket az ágens tölti ki._

## Mit old meg
Ha egy ágens bejelentkezése lejár, az ágens fut, de minden üzenetre csak hibát ad, és ez kívülről nem látszik. Az őr 3 percenként nézi az ágensek képernyőjét, a 3. egymás utáni hibás mérés után (kb. 9 perc) újraindítja a sub-ágenst, és riasztja a tulajdonost.

## Mért hatás
2026-10-29: Cody kb. 18 percig süket volt (17:00-17:18), Gergely videós kérése elveszett; a javítás előtti kód ezt a képernyőt nem ismerte fel (Cody valós képernyőjével reprodukálva, teszt: src/__tests__/reauth-detect.test.ts). Javítás után a teszt felismeri; élesítve 2026-10-29 18:19.

## Részei (automatikus)
- `src/web/reauth-detect.ts`
  - commitok: 5, első: 7a0c4ac0 2026-06-03 feat(dashboard): agent reauth badge + one-click /login + live terminal backend (#275), utolsó: f2165e7b 2026-10-29 fix(reauth-detect): see a login failure that sits above the turn summary line
- `src/web/reauth-healer.ts`
- `src/web/missed-inbound.ts` (újrakézbesítés, e5304fe7)
  - commitok: 14, első: 181b9486 2026-06-03 feat(recovery): autonomous re-auth healer (detect + best-effort /login + escalate) (#276), utolsó: 74b950b6 2026-10-29 fix(reauth-healer): restart a dead fleet-token sub-agent instead of sending /login

## Külső programok (automatikus)
- `tmux`: megvan

## Céges rendszerbe vitel
- Előfeltételek: Claude Code ágensek tmux-ban, közös flotta setup-token (store/.claude-oauth-token), Marveen backend (reauth-healer loop).
- Beállítás lépései: A két fájl a marveen backend része (upstream Szotasz/marveen + helyi javítás f2165e7b, 74b950b6). Céges telepítésen: ugyanez a build; RESPAWN_ENABLED kell a healerhez.
- Mit kell átírni (útvonalak, nevek, csatorna): Semmit a kódban; a riasztás a notify.sh csatornáján megy (ott a céges csatornát kell beállítani).

## Kockázat és felügyelet
Hamis pozitív esetén fölösleges újraindítás (a régi hibasort nem olvassa újra, ha utána új válasz jött). Saját tokenfájlos ágensnél nem indít újra. Interaktív /login-t flotta-tokenes ágensnek nem küld (a megosztott kulcsot forgatná). A süket idő alatt jött csatorna-üzeneteket az újraindítás után egyszer újra kézbesíti (missed-inbound.ts, e5304fe7; Cody valós naplóján a 2 elveszett üzenetet megtalálta).

## Személyes / kihagyandó rész
Nincs.
