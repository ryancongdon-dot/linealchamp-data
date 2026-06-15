#!/usr/bin/env python3
"""
test_nfl_wiki.py — verify the per-team Wikipedia NFL parser on one season.

Run:  python test_nfl_wiki.py [--year 2001] [--show 10]

What it does:
    1. Calls nfl_wiki.fetch_season(year) which discovers per-team pages,
       fetches each, and parses schedule tables.
    2. Prints how many games were parsed.
    3. Shows sample games (sorted by date).
    4. Lists distinct team codes (catches unmapped historical names).
    5. Lists any opponent strings that the team-name mapper couldn't resolve
       (printed during the parse) so we can extend TEAM_TO_CODE.
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from sources import nfl_wiki


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2001)
    p.add_argument("--show", type=int, default=10)
    p.add_argument("--cache-dir", default="cache/NFL/wiki")
    args = p.parse_args()

    print(f"Fetching {args.year} NFL season via per-team Wikipedia pages")
    print(f"(this takes ~30-60 seconds; one fetch per team with a 1-sec polite delay)\n")

    games = nfl_wiki.fetch_season(args.year, Path(args.cache_dir))
    print(f"\n→ Parsed {len(games)} unique games for {args.year}")
    if not games:
        return 2

    # Sort by date for the sample.
    games_sorted = sorted(games, key=lambda g: g.date)
    print(f"\nFirst {args.show} games (chronological):")
    for g in games_sorted[:args.show]:
        print(f"  {g.date[:10]}  {g.away_id:>4} @ {g.home_id:<4}  {g.away_score:>3}-{g.home_score:<3}")
    print(f"\nLast {args.show} games (likely playoffs / Super Bowl):")
    for g in games_sorted[-args.show:]:
        print(f"  {g.date[:10]}  {g.away_id:>4} @ {g.home_id:<4}  {g.away_score:>3}-{g.home_score:<3}")

    codes = Counter()
    for g in games:
        codes[g.home_id] += 1
        codes[g.away_id] += 1
    print(f"\nTeam codes seen ({len(codes)} distinct):")
    for code, n in sorted(codes.items(), key=lambda x: -x[1]):
        print(f"  {code:>5}  {n}")

    expected = 256 if args.year >= 2002 else (240 if args.year >= 1978 else None)
    if expected:
        print(f"\nSanity check: NFL had ~{expected} regular-season games in {args.year} "
              f"(plus playoffs). You parsed {len(games)}.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
