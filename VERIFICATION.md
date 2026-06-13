# Lineage Verification Report

_Last updated: 2026-06-13_

This document audits (1) the **first champion / seed** for every league and
(2) how faithfully each chain traces "the man who beat the man." It is the
working record for getting the data provably correct.

---

## 1. First-champion (seed) verification

| League | Seed champion | Seed date | Status | Notes |
|---|---|---|---|---|
| MLB | Boston Americans | 1903-10-13 | ✅ Correct | First modern World Series (Game 8 clincher). |
| NHL | Toronto Arenas | 1918-03-30 | ✅ Correct | First Stanley Cup of the NHL era. |
| CFB | Princeton | 1869-11-06 | ✅ Correct | First college football game ever (vs Rutgers). |
| EPL | Manchester United | 1993-08-14 | ✅ Correct *by design* | Premier League era only; pre-1992 First Division intentionally excluded. |
| **NBA** | Baltimore Bullets (1948) | 1948-04-21 | ⚠️ Truncated | True first champ is the **1947 Philadelphia Warriors**. balldontlie data starts Nov 1947, so the '47 BAA Finals are unavailable. **→ backfill planned.** |
| **NFL** | Tampa Bay (2002) | 2003-01-26 | ❌ Truncated | Missing **1920–2001** (~80 years). balldontlie NFL data starts 2002. **→ backfill planned.** |
| Boxing HW | John L. Sullivan | 1882-02-07 | ✅ Correct (fixed) | Was wrongly seeded 1892-09-07 (the day he *lost*). Now seeded at the Paddy Ryan win. |
| Boxing LHW | Jack Root | 1903-04-22 | ✅ Correct | Won the inaugural light-heavyweight title fight vs Kid McCoy. |

### Decision taken
- **NBA / NFL:** backfill full history from a fuller source (basketball-reference
  back to 1946; pro-football-reference back to 1920). Until then, both chains
  are knowingly partial.

---

## 2. Boxing Heavyweight chain audit (Sullivan → Usyk)

Cross-checked against the consensus lineal record (The Ring / Cyber Boxing Zone).
**44 reigns, all transitions verified accurate** except as noted.

### Findings
1. **Sullivan seed date — FIXED.** Was 1892-09-07 (his loss date); corrected to
   1882-02-07 (Paddy Ryan win). His 1889 Kilrain defense now sits correctly
   inside the reign.
2. **Marvin Hart omitted (1905–06).** After Jeffries retired, Marvin Hart beat
   Jack Root (Jul 1905) for the vacant title before losing to Burns (Feb 1906).
   We collapse Jeffries → Burns directly. Defensible (Hart's claim is widely
   treated as weak), but some records include him. **Decision needed:** include
   Hart as a brief reign, or keep the simplification?
3. **Vacancy-bridge transitions display imperfectly.** Five reigns were won from
   a *vacant* title, not by beating the previous lineal champ:
   Schmeling (1930), Patterson (1956), Frazier (1971), Holmes (1980),
   W. Klitschko (2011). In the data the `from` field still points at the prior
   lineal holder, so the "recent belt changes" feed can read e.g.
   "Klitschko over Lewis" — a fight that never happened. **Recommended fix:**
   add a `viaVacancy: true` flag + real opponent name, and render these as
   "won vacant title vs <opponent>" instead of "over <previous champ>."

Everything else (Corbett, Fitzsimmons, Jeffries, Johnson, Willard, Dempsey,
Tunney, Sharkey, Carnera, Baer, Braddock, Louis, Charles, Walcott, Marciano,
Johansson, Liston, Ali ×3, Foreman ×2, Spinks L., Holmes, Spinks M., Tyson,
Douglas, Holyfield ×2, Bowe, Moorer, Briggs, Lewis ×2, Fury, Usyk) checks out
on date, method, and direction of transfer.

---

## 3. Boxing Light Heavyweight chain audit (Root → Bivol)

**43 reigns.** Spot-checked at the major anchors: Root (1903 inaugural),
Fitzsimmons adding LHW, Carpentier, Siki, Loughran, Rosenbloom, John Henry
Lewis, Conn, Moore (10-yr reign), Foster, Spinks unification, Roy Jones Jr's
1999 restoration, Hopkins ×2, Beterbiev's 2024 undisputed run, Bivol (current).
Same vacancy-bridge display caveat as HW applies to the 1905–1916, 1985–1999,
and 2008–2011 gaps.

Defense coverage is lighter than HW (34 vs 145 events) — the marquee reigns
(Moore, Foster, Jones, Beterbiev) are covered; minor reigns are title-change-only.

---

## 4. Methodology check (sports leagues)

The lineage algorithm (`lineage.py` / `computeLineage` in worker.js) was reviewed:
- **Belt transfer:** holder loses → winner takes the belt. Holder wins or ties →
  no change. ✅ Correct.
- **Seed:** if `SEED_TEAM` is set, the belt starts there on `SEED_DATE`; if
  `None`, the first game on/after `SEED_DATE` seeds it to that winner (used to
  pin NBA/NHL/MLB/NFL to a championship game). ✅ Correct.
- **Vacancy:** `VACANCY_DAYS` (MLB/NHL = 365) auto-transfers the belt to the next
  game's winner if the holder hasn't played in over a year — prevents the title
  stranding on defunct franchises. ✅ Correct.

The full game-by-game **chain trace** for the 6 sports can only be re-verified
against the cached game data on the local machine (not available in the cloud
sandbox). Action item: after the NBA/NFL backfill, run a chain-trace spot check
at known championship moments for each league.

---

## 5. Open action items

- [ ] Backfill NBA (1946+) and NFL (1920+) from a fuller data source.
- [ ] Decide: include Marvin Hart (HW, 1905–06) or keep the simplification.
- [ ] Add `viaVacancy` handling so vacant-title wins don't render as fictional
      head-to-head belt changes.
- [ ] Sports-league chain-trace spot check at championship anchors (post-backfill).
- [ ] Deploy Light Heavyweight (built, not yet live).
