# Lineage Verification Report

_Last updated: 2026-06-15_

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
| NBA | Philadelphia Warriors (1947) | 1947-04-22 | ✅ Correct (fixed) | BDL stores 1947 PHW games under "GSW" (modern franchise code). Seeded synthetically; first BDL games (Nov 1947) the Warriors play either keep or transfer from there. |
| **NFL** | Tampa Bay (2002) | 2003-01-26 | ❌ Truncated | Missing **1933–2001** (~69 years). balldontlie NFL data starts 2002; pro-football-reference is WAF-blocked. **→ requires a new data source. See §6.** |
| Boxing HW | John L. Sullivan | 1882-02-07 | ✅ Correct (fixed) | Was wrongly seeded 1892-09-07 (the day he *lost*). Now seeded at the Paddy Ryan win. |
| Boxing LHW | Jack Root | 1903-04-22 | ✅ Correct | Won the inaugural light-heavyweight title fight vs Kid McCoy. |

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
  `None`, the first game on/after `SEED_DATE` seeds it to that winner. ✅ Correct.
- **Vacancy:** `VACANCY_DAYS` (MLB/NHL = 365) auto-transfers the belt to the next
  game's winner if the holder hasn't played in over a year — prevents the title
  stranding on defunct franchises. ✅ Correct.

---

## 5. Open action items

- [x] ~~Backfill NBA — done (synthetic seed at 1947 PHW)~~
- [ ] **Backfill NFL** (1933–2001) — see §6 for the source options.
- [ ] Decide: include Marvin Hart (HW, 1905–06) or keep the simplification.
- [ ] Add `viaVacancy` handling so vacant-title wins don't render as fictional
      head-to-head belt changes.
- [ ] Sports-league chain-trace spot check at championship anchors.
- [ ] Deploy Light Heavyweight (built; uploaded; pending portrait cleanup).

---

## 6. NFL backfill — source options

`pro-football-reference.com` has the full game history but blocks all
non-residential IPs with a hard 403 WAF (verified by previous development
attempt — note preserved in `sources/nfl.py`). Wrangler-deploy IPs and
common-cloud IPs are all blocked. This rules out the obvious source.

Realistic alternatives, ranked:

1. **Wikipedia season pages** (`https://en.wikipedia.org/wiki/{YEAR}_NFL_season`).
   - Pro: no WAF, stable URLs, every season since 1920 exists.
   - Con: HTML format varies significantly across eras (1933–1969 pre-merger
     pages look nothing like 1990s pages). Writing a parser that's robust
     across all formats is multi-day work. Team-name disambiguation is
     non-trivial (Decatur Staleys → Chicago Bears, multiple Rams relocations,
     Cleveland Browns ≠ Cleveland Browns after 1995 hiatus, etc.).
   - Estimated effort: 2–3 focused days of dev + testing.

2. **nflverse public CSV releases** (`https://github.com/nflverse/...`).
   - Pro: clean, structured, well-maintained.
   - Con: their `games.csv` only goes back to **1999**. Doesn't solve the
     1933–1998 gap.

3. **ESPN unofficial scoreboard API**
   (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD`).
   - Pro: structured JSON, no WAF.
   - Con: depth of NFL coverage is uncertain — believed to go back to ~1922
     but anecdotal reports say pre-1970 coverage is patchy. One-day-at-a-time
     queries mean ~25,000+ API calls for full backfill.
   - Estimated effort: 1 day if coverage is good, indefinite if not.

4. **Hand-curated championship-game-only chain** — list NFL championships
   (1933 Bears, 1934 Giants, …) and seed the chain at each year's champion,
   accepting that we lose intra-season belt transfers from regular-season
   losses.
   - Pro: ~75 hand-typed rows, ready immediately.
   - Con: not faithful to "the man who beat the man" — we'd miss every
     regular-season belt transfer. Inconsistent with how the 6 sports work.

5. **Accept the 2002 truncation** and document it prominently in the UI.

**Recommended path:** option 1 (Wikipedia parser) as the proper fix.
Option 5 as the no-fluff fallback. Option 4 only if you specifically want
something visible faster at the cost of accuracy.

