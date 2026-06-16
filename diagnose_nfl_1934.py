"""
diagnose_nfl_1934.py — investigate whether the 1934 NFL Championship Game
(Bears 13, Giants 30 on Dec 9) made it into our data, or whether our parser
missed it.

This determines if the bug is:
  (a) Parser gap — Wikipedia table format we didn't catch on 1934 team pages
  (b) Lineage processing — game was captured but not turned into a belt change

Run:  py diagnose_nfl_1934.py
"""

from __future__ import annotations

import json
from pathlib import Path


def main() -> int:
    # ── 1. Events from the lineage output ───────────────────────────────────
    print("=== 1. Lineage events for December 1934 (champion-involved games) ===")
    events_file = Path("output/events-NFL.json")
    if not events_file.exists():
        print("  output/events-NFL.json not found — run build_lineage.py first.")
        return 1
    events = json.load(events_file.open())["events"]
    dec_1934 = [x for x in events if x["date"].startswith("1934-12")]
    print(f"  count: {len(dec_1934)}")
    for x in dec_1934:
        score = str(x["champScore"]) + "-" + str(x["oppScore"])
        print(f"    {x['date'][:10]}  {x['champ']} vs {x['opponent']}  {score}  {x['result']}")

    # ── 2. Bears games in the 1934 Wikipedia cache (source data) ────────────
    print()
    print("=== 2. Bears games in the 1934 Wikipedia cache (source data) ===")
    cache_file = Path("cache/NFL/wiki/wiki-1934.json")
    if not cache_file.exists():
        print("  cache/NFL/wiki/wiki-1934.json not found.")
        return 1
    games = json.load(cache_file.open())
    chi = [x for x in games if x["home_id"] == "CHI" or x["away_id"] == "CHI"]
    chi.sort(key=lambda g: g["date"])
    print(f"  count: {len(chi)}")
    for x in chi:
        a = str(x["away_score"])
        h = str(x["home_score"])
        print(f"    {x['date'][:10]}  {x['away_id']} @ {x['home_id']}  {a}-{h}")

    # ── 3. Specifically — is there a Bears-Giants game on Dec 9 1934? ───────
    print()
    print("=== 3. Bears vs Giants on Dec 9, 1934 (the Championship Game) ===")
    target = [
        x for x in games
        if x["date"].startswith("1934-12-09")
        and {x["home_id"], x["away_id"]} == {"CHI", "NYG"}
    ]
    if target:
        for x in target:
            a = str(x["away_score"])
            h = str(x["home_score"])
            print(f"  FOUND:  {x['date'][:10]}  {x['away_id']} @ {x['home_id']}  {a}-{h}")
    else:
        print("  NOT FOUND in 1934 Wikipedia cache.")
        print("  → Diagnosis: parser missed the game (probable cause: 1934 team")
        print("    season pages format the Championship game in a table our")
        print("    schedule-shape detector doesn't recognize).")

    # ── 4. Total 1934 games captured, for sanity ────────────────────────────
    print()
    print("=== 4. Total 1934 games captured ===")
    print(f"  {len(games)} games (expected: ~58-65 for the 11-team 1934 NFL season)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
