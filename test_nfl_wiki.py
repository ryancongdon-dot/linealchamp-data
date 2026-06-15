#!/usr/bin/env python3
"""
test_nfl_wiki.py — diagnostic for the Wikipedia NFL parser.

Run:  python test_nfl_wiki.py [--year 2001] [--show 5]
      python test_nfl_wiki.py --year 2001 --diagnose
      python test_nfl_wiki.py --year 2001 --inspect-team "New England Patriots"

Modes:
  default:        try to parse the season page; print what's extracted
  --diagnose:     dump every table on the season page and search for schedule
                  data so we can locate where the games actually live
  --inspect-team: fetch a per-team season page (e.g. "2001 New England
                  Patriots season") and check whether IT has a schedule table
                  we can parse instead.
"""

from __future__ import annotations

import argparse
import re
from collections import Counter
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from sources import nfl_wiki


def _print_table_summary(table, idx: int) -> None:
    classes = table.get("class") or []
    caption = table.find("caption")
    caption_txt = caption.get_text(" ", strip=True) if caption else ""
    rows = table.find_all("tr")
    header_cells = rows[0].find_all(["th", "td"]) if rows else []
    headers = [c.get_text(" ", strip=True) for c in header_cells]
    print(f"  Table #{idx}: class={classes!r}  rows={len(rows)}  caption={caption_txt[:60]!r}")
    print(f"    headers: {headers[:10]}")


def cmd_default(year: int, show: int, cache_dir: str) -> int:
    """Original test: run the parser, print what came out."""
    url = nfl_wiki.WIKI_URL.format(year=year)
    print(f"Fetching {url} ...")
    r = requests.get(url, headers={"User-Agent": nfl_wiki.WIKI_UA}, timeout=30)
    print(f"  HTTP {r.status_code} | {len(r.text):,} bytes")
    if r.status_code != 200:
        return 1

    soup = BeautifulSoup(r.text, "html.parser")
    tables = soup.find_all("table", class_="wikitable")
    print(f"  Found {len(tables)} <table class='wikitable'> elements.")

    games = nfl_wiki.fetch_season(year, Path(cache_dir))
    print(f"\nParser extracted {len(games)} games.")
    if not games:
        print("  ✗ No games. Run with --diagnose to inspect page structure.")
        return 2

    print(f"\nFirst {show} games:")
    for g in games[:show]:
        print(f"  {g.date[:10]}  {g.away_id:>4} @ {g.home_id:<4}  {g.away_score}-{g.home_score}")

    codes = Counter()
    for g in games:
        codes[g.home_id] += 1
        codes[g.away_id] += 1
    print(f"\nTeam codes ({len(codes)} distinct):")
    for code, n in sorted(codes.items(), key=lambda x: -x[1]):
        print(f"  {code:>5}  {n}")
    return 0


def cmd_diagnose(year: int) -> int:
    """Dump every table + look for schedule data elsewhere on the page."""
    url = nfl_wiki.WIKI_URL.format(year=year)
    print(f"Diagnosing {url}")
    r = requests.get(url, headers={"User-Agent": nfl_wiki.WIKI_UA}, timeout=30)
    if r.status_code != 200:
        print(f"  HTTP {r.status_code}")
        return 1
    soup = BeautifulSoup(r.text, "html.parser")

    # 1. Every table (any class).
    all_tables = soup.find_all("table")
    print(f"\nAll tables on the page: {len(all_tables)}")
    for i, t in enumerate(all_tables):
        _print_table_summary(t, i)

    # 2. Section headings — tells us where 'Schedule', 'Regular season',
    #    'Game results' etc. live (or whether they exist at all).
    print("\nSection headings:")
    for h in soup.find_all(["h2", "h3", "h4"]):
        txt = h.get_text(" ", strip=True)
        if txt:
            print(f"  {h.name}  {txt[:80]}")

    # 3. Hunt for date patterns near team names in body text.
    body = soup.get_text(" ", strip=True)
    date_hits = re.findall(r"(?:January|February|September|October|November|December)\s+\d{1,2}", body)
    print(f"\nDate-like substrings found in page text: {len(date_hits)}")
    if date_hits:
        print(f"  e.g. {date_hits[:5]}")

    # 4. Are there links to per-team season pages?
    team_season_links = [a for a in soup.find_all("a", href=True)
                        if re.search(rf"^/wiki/{year}_[A-Z][\w_]+_season$", a["href"])]
    print(f"\nPer-team season page links: {len(team_season_links)}")
    for a in team_season_links[:5]:
        print(f"  {a['href']}  text={a.get_text(' ', strip=True)[:40]!r}")

    # 5. Suggest next move.
    print("\nNext steps:")
    if team_season_links:
        sample = team_season_links[0].get_text(" ", strip=True)
        print(f"  Per-team pages exist. Try:  py test_nfl_wiki.py --inspect-team \"{sample}\"")
    print("  If schedule data isn't here at all, pivot strategy: parse per-team pages")
    print("  ({YEAR}_{TEAM}_season) which typically DO have full schedule tables.")
    return 0


def cmd_inspect_team(year: int, team_name: str) -> int:
    """Fetch a per-team season page and inspect its schedule tables."""
    slug = team_name.replace(" ", "_")
    url = f"https://en.wikipedia.org/wiki/{year}_{slug}_season"
    print(f"Fetching {url}")
    r = requests.get(url, headers={"User-Agent": nfl_wiki.WIKI_UA}, timeout=30)
    print(f"  HTTP {r.status_code} | {len(r.text):,} bytes")
    if r.status_code != 200:
        # Try alternate URL form ("season_X" instead of "X_season")
        alt = f"https://en.wikipedia.org/wiki/{year}_{slug}"
        print(f"  Trying alternate: {alt}")
        r = requests.get(alt, headers={"User-Agent": nfl_wiki.WIKI_UA}, timeout=30)
        print(f"  HTTP {r.status_code}")
        if r.status_code != 200:
            return 1
    soup = BeautifulSoup(r.text, "html.parser")
    tables = soup.find_all("table", class_="wikitable")
    print(f"  Found {len(tables)} wikitables.")
    for i, t in enumerate(tables):
        _print_table_summary(t, i)

    # Look for one that smells like a schedule.
    schedule_table = None
    for t in tables:
        rows = t.find_all("tr")
        if not rows:
            continue
        headers = [c.get_text(" ", strip=True).lower() for c in rows[0].find_all(["th", "td"])]
        if any("date" in h for h in headers) and any(
            "opponent" in h or "result" in h or "score" in h for h in headers
        ):
            schedule_table = t
            break

    if schedule_table:
        print("\n✓ Schedule-shaped table found. First 5 rows:")
        for row in schedule_table.find_all("tr")[:6]:
            cells = row.find_all(["th", "td"])
            print("   ", [c.get_text(' ', strip=True)[:30] for c in cells])
    else:
        print("\n✗ No schedule-shaped table on this team page either.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2001)
    p.add_argument("--show", type=int, default=5)
    p.add_argument("--cache-dir", default="cache/NFL/wiki")
    p.add_argument("--diagnose", action="store_true",
                   help="Dump every table on the season page so we can locate the schedule")
    p.add_argument("--inspect-team", default=None,
                   help='Fetch a per-team season page, e.g. "New England Patriots"')
    args = p.parse_args()

    if args.inspect_team:
        return cmd_inspect_team(args.year, args.inspect_team)
    if args.diagnose:
        return cmd_diagnose(args.year)
    return cmd_default(args.year, args.show, args.cache_dir)


if __name__ == "__main__":
    raise SystemExit(main())
