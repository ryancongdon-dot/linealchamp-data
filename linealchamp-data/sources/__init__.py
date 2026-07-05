"""
Per-league source modules.

Each module exposes:
    SEED_TEAM: str             # normalized (uppercase, no whitespace) team code
    SEED_DATE: str             # ISO date, e.g. "1947-04-22"
    fetch_all_games(start, end, cache_dir) -> list[Game]

Sources are chosen for stability over breadth:
  - nba.py  : balldontlie historical (1946+)
  - nfl.py  : pro-football-reference season pages (1920+)
  - mlb.py  : Retrosheet game logs pre-2012, MLB StatsAPI 2012+ (incl. postseason)
  - nhl.py  : hockey-reference season pages (1917+)
  - epl.py  : balldontlie EPL (1992+) with shape probe
  - cfb.py  : collegefootballdata.com (1869+, FBS-filtered via membership table)

Caching: raw downloads land in cache/, but a cached file is only reused when
the window it covers ended before the file was written (sources/util.py).
Anything covering a still-open season is refetched on every run — that's what
keeps re-builds from silently freezing a league at the date of the first run.

If a source module fails or returns nothing for a year, that year is skipped
with a warning — the rest of the build continues. The build_lineage.py
orchestrator prints a per-league summary so you can see which years are missing.
"""
