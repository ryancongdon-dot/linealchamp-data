# Branch Points Catalog

_The "what if" feature design doc — every historical inflection point
where the lineal chain could defensibly have gone differently, and how
we'd let users explore those alternates._

This is the **v1 scope** decision: only branches we can express by
recomputing on data we already have. The hard ones (parallel-league
chains like the AFL, alternate-result simulations) are flagged at the
bottom for later.

---

## Design model

A **branch point** is a historical decision we made when building the
canonical chain. Each one is registered with:

- **id** — slug used in URLs and code (e.g. `marciano-1956`).
- **sport / class** — which tab it applies to.
- **canonical** — the path the chain currently takes.
- **alternates** — one or more named paths the chain could have taken.
- **edit** — a structured description of how to mutate the chain to
  produce each alternate (truncate, insert, swap result, etc.).

The UI exposes a **"What if?"** panel per tab. The user toggles
alternates; the frontend re-walks the chain client-side with the
selected edits applied, and re-renders the tracker. No KV roundtrip,
no recompute server-side.

### Edit primitives (v1)

- `truncate_after_date(date)` — chain ends here; no successors.
- `truncate_after_reign(champ_id)` — chain ends when this champion's
  reign ends.
- `skip_reign(champ_id, reign_index?)` — remove this reign; whoever
  beat the previous champion takes the belt to whoever next defeats
  them.
- `insert_reign(after_champ_id, new_champ_id, date, score, opponent)` —
  add a reign that we currently omit.
- `change_result(game_id, new_result)` — flip W↔L, or set to draw, on
  a specific contested fight (the chain re-walks from that point).
- `compose(...)` — combine multiple edits into one named branch.

---

## Boxing Heavyweight

### `marvin-hart-1905`
**Inflection:** Jeffries retires undefeated in 1905; Marvin Hart wins a tournament against Jack Root in July 1905; Tommy Burns beats Hart in Feb 1906.
**Canonical:** We collapse Jeffries → Burns (vacancy bridge). Hart is omitted.
**Alternate:** "Include Hart" — Hart is the lineal champion July 1905 → Feb 1906.
**Edit:** `insert_reign(after="JEFFRIES", new="HART", date="1905-07-03", score="UD20", opponent="Jack Root")`

### `tunney-retired-1928`
**Inflection:** Tunney retires undefeated in 1928.
**Canonical:** Vacant ~2 years; Schmeling restarts the chain in 1930.
**Alternate:** "Chain broken at Tunney" — no lineal HW champion after Sept 1928.
**Edit:** `truncate_after_reign("TUNNEY")`

### `marciano-retired-1956`
**Inflection:** Marciano retires 49-0 in April 1956 — the only undefeated retiree in HW history.
**Canonical:** Patterson restarts the chain in Nov 1956 by beating Archie Moore for the vacant title (The Ring magazine's lineage).
**Alternate:** "Strict purist mode" — Marciano was never beaten, so no one can ever inherit the lineal title from him. The chain ends in 1956 and there has been no lineal heavyweight champion since.
**Edit:** `truncate_after_reign("MARCIANO")`

### `ali-stripped-1967`
**Inflection:** Ali stripped April 1967 for refusing the Vietnam draft.
**Canonical:** Vacant; Frazier becomes lineal by beating Ali at MSG on Mar 8, 1971 (Fight of the Century).
**Alternate A:** "Frazier earlier" — Frazier becomes lineal in Feb 1970 when he beats Jimmy Ellis to unify the WBA + NY/Maine recognition.
**Alternate B:** "Vacant until Ali returns" — chain held vacant; only reclaimed when Ali wins it back in 1974 (Rumble in the Jungle).
**Edit (A):** `insert_reign(after="MUHAMMADALI_R1", new="FRAZIER", date="1970-02-16", score="TKO5", opponent="Jimmy Ellis")` plus skip the existing Frazier seed.
**Edit (B):** `truncate_after_date("1967-04-28")` for the vacancy period; chain resumes at Ali's 1974 win.

### `ali-retired-1979`
**Inflection:** Ali retires summer 1979.
**Canonical:** Vacant; Holmes restores the chain by beating Ali in his Oct 1980 comeback.
**Alternate:** "Chain broken at Ali" — no lineal champion after 1979; Holmes is just a WBC titleholder, not lineal.
**Edit:** `truncate_after_reign("MUHAMMADALI_R3")`

### `briggs-foreman-1997`
**Inflection:** Briggs wins a widely-disputed majority decision over Foreman in Nov 1997.
**Canonical:** Include Briggs as a brief lineal champion (official result governs).
**Alternate:** "Foreman robbed" — skip Briggs; treat Foreman as the holder until he retires, then Lewis becomes lineal by beating Briggs anyway in March 1998.
**Edit:** `skip_reign("BRIGGS")`

### `lewis-retired-2004`
**Inflection:** Lewis retires in February 2004, soon after the controversial Klitschko fight.
**Canonical:** Vacant 7 years; Wladimir Klitschko unifies WBA + WBO + IBF by beating Haye in 2011 and is recognized as lineal.
**Alternate A:** "Chain broken at Lewis" — no lineal champion 2004–present.
**Alternate B:** "Vitali in 2004" — Vitali Klitschko (who would have lost to Lewis if not stopped on cuts, then won the vacant WBC by beating Corrie Sanders four months later) is the lineal champion until his retirement, with Wladimir picking up after.
**Edit (A):** `truncate_after_reign("LEWIS_R2")`
**Edit (B):** Compose of `insert_reign(after="LEWIS_R2", new="KLITSCHKOVITALI", date="2004-04-24", score="TKO8", opponent="Corrie Sanders")` plus other inserts for his reign.

### `lewis-holyfield-i-1999`
**Inflection:** Lewis–Holyfield I on Mar 13, 1999 was officially a draw widely seen as a Lewis robbery; included as a Lewis "defense" in our chain.
**Canonical:** Lewis retains the lineal title through this fight.
**Alternate:** "Draw vacates" — the draw was so bad it should have vacated the title; Lewis only becomes the *real* lineal champ when he wins the November rematch decisively.
**Edit:** `change_result(game_id="...LEWIS_R1-D02", to="D")` + `truncate_after_date` re-seed at the Nov 13 rematch.

### `fury-vacated-2016`
**Inflection:** Fury vacates all belts in 2016 due to mental-health hiatus; returns in 2018 and never loses in the ring until Usyk beats him in 2024.
**Canonical:** Fury retains lineal status throughout the hiatus (no one ever beat him).
**Alternate:** "Vacancy on vacate" — Fury vacating *also* vacates lineal status; chain held vacant 2016 → 2024 (Usyk undisputed) since no unification happened in between.
**Edit:** `truncate_after_date("2016-10-12")` and re-seed at Usyk 2024 undisputed.

### `klitschko-lewis-2003`
**Inflection:** Lewis beat Vitali by TKO (cuts) in June 2003; Vitali was leading on all three scorecards when the fight was stopped.
**Canonical:** Lewis wins; defends the lineal title.
**Alternate:** "Vitali wins on cuts" — Vitali becomes lineal champion in June 2003 (since he was winning); then continues through his career.
**Edit:** `change_result(game_id="...LEWIS_R2-D02", to="L")` and re-walk from there.

---

## Boxing Light Heavyweight

### `archie-moore-stripped-1962`
**Inflection:** Moore is stripped in 1962 for failing to defend; he then retires.
**Canonical:** Harold Johnson is the lineal successor.
**Alternate:** "Chain broken at Moore" — strict-purist view, no LHW lineal champ after 1962.
**Edit:** `truncate_after_reign("MOORE")`

### `spinks-vacates-1985`
**Inflection:** Michael Spinks moves up to heavyweight in 1985 after unifying the LHW titles.
**Canonical:** Vacant 14 years; Roy Jones Jr. restores lineal by unifying WBA/WBC/IBF in 1999.
**Alternate A:** "Chain broken at Spinks" — no LHW lineal 1985 → present.
**Alternate B:** "Earlier Jones" — Jones becomes lineal in 1996 when he wins the IBF (one belt earlier).
**Edit (A):** `truncate_after_reign("SPINKSMICHAEL")`
**Edit (B):** `insert_reign` shifting Jones's reign-start earlier.

### `calzaghe-retired-2008`
**Inflection:** Calzaghe retires undefeated at the end of 2008.
**Canonical:** Vacant until Hopkins reclaims by beating Pascal in 2011.
**Alternate:** "Chain broken at Calzaghe" — strict-purist view.
**Edit:** `truncate_after_reign("CALZAGHE")`

### `bivol-beterbiev-i-2024`
**Inflection:** Beterbiev beat Bivol by majority decision in Oct 2024 in a fight many had Bivol winning; the Feb 2025 rematch went to Bivol clearly.
**Canonical:** Beterbiev was briefly lineal Oct 2024 → Feb 2025; Bivol regains in the rematch.
**Alternate:** "Bivol always was the champ" — the Oct 2024 result was wrong; Bivol's reign never paused.
**Edit:** `change_result(beterbiev-bivol-1, to="L")` then re-walk.

---

## NBA

### `lakers-relocation-1960`
**Inflection:** Minneapolis Lakers relocate to Los Angeles in 1960.
**Canonical:** Same franchise; chain continues through the move.
**Alternate:** "Relocation breaks identity" — Minneapolis Lakers cease to exist 1960; LA Lakers are a new franchise that doesn't inherit the belt.
**Edit:** Would need a "franchise-identity" branch type; v1 might just truncate at relocation.

### `aba-merger-1976` (HARD — flagged for v2)
**Why:** Real answer requires ABA game data and team mapping.

---

## NFL

### `1933-vs-1920-seed` (HARD — flagged for v2)
**Inflection:** NFL existed 1920–1932 with championships awarded by standings, not a championship game.
**Canonical:** Chain starts at the 1933 Championship Game (Bears 23, Giants 21).
**Alternate:** Chain starts in 1920 with the Akron Pros (first standings champion).
**Why HARD:** We don't have pre-1933 game data via the Wikipedia per-team scrape; we'd need a separate source for the 1920–1932 era.

### `afl-nfl-merger-1970` (HARD — flagged for v2)
**Inflection:** AFL and NFL merge in 1970. The AFL had its own champions 1960–1969 (most famously the Jets winning Super Bowl III).
**Canonical:** NFL chain continues through the merger as if AFL never existed.
**Alternate:** AFL chain is the "true" chain post-1969 (Jets, Chiefs).
**Why HARD:** Need AFL game data 1960–1969.

### `browns-relocation-1996`
**Inflection:** Browns "move" to Baltimore and become the Ravens in 1996; the new "Browns" begin play in 1999 with NFL-recognized franchise continuity.
**Canonical:** New Browns inherit the franchise identity; Ravens are an expansion team.
**Alternate:** "Ravens are the real Browns" — Baltimore inherits the chain (Belichick's roster, same colors only by virtue of new ownership).
**Edit:** This becomes a team-code rewrite from a date forward; doable in v1 with a `rename_team` edit primitive.

---

## MLB

### `1994-strike-no-ws`
**Inflection:** The 1994 World Series was cancelled due to the players' strike.
**Canonical:** Belt stays with the previous holder for that year (no transfer).
**Alternate:** "Vacated by strike" — belt vacated; next year's WS winner restarts the chain.
**Edit:** `truncate_after_date("1994-08-12")` + re-seed at 1995 World Series winner.

### `1981-strike-shortened`
**Inflection:** Strike shortened the season; the World Series still happened (Dodgers won).
**Canonical:** Belt transfers normally.
**Alternate:** "Asterisk year — no recognition" — Dodgers don't count, belt stays with previous holder.
**Edit:** `skip_reign` for the 1981 winner.

---

## NHL

### `2004-05-lockout`
**Inflection:** Stanley Cup not awarded; entire 2004–05 season cancelled.
**Canonical:** Belt stays with previous holder (Lightning, who won in 2004).
**Alternate:** "Vacated by lockout" — belt vacated; chain resumes with 2006 champion.
**Edit:** `truncate_after_date("2004-06-07")` + re-seed at 2006 winner.

### `wha-merger-1979` (HARD — flagged for v2)
**Why HARD:** Need WHA game data 1972–1979.

---

## EPL

### `1992-pl-start-vs-old-first-division` (HARD — flagged for v2)
**Inflection:** Premier League launched in 1992. The First Division existed before that with the same top-tier function.
**Canonical:** Chain starts at 1992-93 with Manchester United (Premier League era only).
**Alternate:** Continue back from the 1991-92 First Division champion (Leeds United) and earlier.
**Why HARD:** Need First Division game data pre-1992.

---

## CFB

### `1869-vs-1998-seed`
**Inflection:** College football's first formal national championship was the 1998 BCS Championship Game. Before that, the title was awarded by polls and is widely contested year to year.
**Canonical:** Chain starts in 1869 at the first college football game (Princeton vs Rutgers) — an "arbitrary but meaningful" anchor.
**Alternate:** "Modern era only" — chain starts at the 1998 BCS Championship (Tennessee).
**Edit:** `truncate_before_date("1998-01-04")` + re-seed at Tennessee.

---

## v1 build summary

**Easy branches we can ship now:** ~16 across all sports.
**Hard branches deferred:** 5 (require new data — flagged).

**Implementation pattern:**
1. Each `BranchPoint` object stored in worker.js JS (no KV cost).
2. `/api/lineage` always returns the canonical chain.
3. Frontend has a `What if?` panel that lists relevant branch points for
   the current tab. Toggling one re-walks the loaded chain client-side
   with the selected edits applied.
4. URL persists branch selection (`?l=BOXHW&branch=marciano-1956`) so
   states are shareable.
5. The tracker UI shows a subtle banner ("Alternate timeline: Marciano
   retires the chain") when any branch is active, plus a "Reset to
   canonical" button.

**Estimated build effort:**
- 2-3 sessions to ship a clean v1 with the boxing HW branches (most
  interesting set) + a basic toggle UI.
- Add LHW + NFL/MLB/NHL/CFB branches in follow-up sessions as content
  rather than code.

---

## What's NOT in v1

The "individual game result simulator" the user explicitly deferred:
- "What if the 1947 Warriors had lost Game 5?"
- "What if Tyson had beaten Buster Douglas in Tokyo?"
- These require simulating downstream consequences across hundreds of
  games. Fun, but high complexity and lower payoff than the discrete
  inflection-point branches above.
