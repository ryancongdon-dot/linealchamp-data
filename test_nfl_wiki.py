#!/usr/bin/env python3
"""
test_nfl_wiki.py — verify the Wikipedia NFL parser against a single season
*before* committing to a full 1933-2001 backfill.

Run:  python test_nfl_wiki.py [--year 2001] [--show 5]

Prints:
    - HTTP status / fetch info
    - How many wikitables were found and how many parsed as schedule tables
    - Total games extracted
    - The first N games' raw shapes
    - A roll-up of which team codes were seen (so we can spot the long tail of
      historical / disambiguated names that our team-mapping doesn't cover yet)
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from sources import nfl_wiki


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2001,
                   help="NFL season year to test (defaults to 2001, well-known modern season)")
    p.add_argument("--show", type=int, default=5,
                   help="Print this many sample games")
    p.add_argument("--cache-dir", default="cache/NFL/wiki",
                   help="Where to cache the Wikipedia page")
    args = p.parse_args()

    # 1. Raw fetch — confirm Wikipedia returns the page.
    url = nfl_wiki.WIKI_URL.format(year=args.year)
    print(f"Fetching {url} ...")
    r = requests.get(url, headers={"User-Agent": nfl_wiki.WIKI_UA}, timeout=30)
    print(f"  HTTP {r.status_code} | {len(r.text):,} bytes")
    if r.status_code != 200:
        print("  ✗ Wikipedia did not return the page; parser cannot run.")
        return 1

    # 2. Inventory the tables.
    soup = BeautifulSoup(r.text, "html.parser")
    tables = soup.find_all("table", class_="wikitable")
    print(f"  Found {len(tables)} <table class='wikitable'> elements.")

    # 3. Run the parser through the cached pipeline.
    games = nfl_wiki.fetch_season(args.year, Path(args.cache_dir))
    print(f"\nParser extracted {len(games)} games.")

    if not games:
        print("  ✗ No games extracted. Likely causes:")
        print("    - This season's page uses a different table format (winner/loser columns?)")
        print("    - Header strings don't contain 'date'/'home'/'visitor'/'result'.")
        print("    - Team names in this era aren't in TEAM_TO_CODE.")
        print("\n  Dumping the first table's first 3 rows so we can adjust:")
        if tables:
            for row in tables[0].find_all("tr")[:3]:
                cells = row.find_all(["th", "td"])
                print("   ", [c.get_text(' ', strip=True)[:40] for c in cells])
        return 2

    # 4. Show samples.
    print(f"\nFirst {args.show} games parsed:")
    for g in games[:args.show]:
        print(f"  {g.date[:10]}  {g.away_id:>4} @ {g.home_id:<4}  {g.away_score}-{g.home_score}")

    # 5. Team-code distribution — surfaces normalization gaps.
    codes = Counter()
    for g in games:
        codes[g.home_id] += 1
        codes[g.away_id] += 1
    print(f"\nTeam codes seen ({len(codes)} distinct):")
    for code, n in sorted(codes.items(), key=lambda x: -x[1]):
        print(f"  {code:>5}  {n}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
