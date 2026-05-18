"""
Per-league source modules.

Each module exposes:
    SEED_TEAM: str             # normalized (uppercase, no whitespace) team code
    SEED_DATE: str             # ISO date, e.g. "1947-04-22"
    fetch_all_games(start, end, cache_dir) -> list[Game]

Sources are chosen for stability over breadth:
  - nba.py  : balldontlie historical (1946+), plus optional Wikipedia cross-check
  - nfl.py  : nflverse CSV releases (1999+), with hand-curated pre-1999 champions
  - mlb.py  : Retrosheet game logs (1871+)
  - nhl.py  : api-web.nhle.com season schedules + ESPN historical scoreboard
  - epl.py  : balldontlie EPL (1992+) with shape probe; fbref fallback
  - cfb.py  : collegefootballdata.com (1869+, FBS-filtered via membership table)

If a source module fails or returns nothing for a year, that year is skipped
with a warning — the rest of the build continues. The build_lineage.py
orchestrator prints a per-league summary so you can see which years are missing.
"""
