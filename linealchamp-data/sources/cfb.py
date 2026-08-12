"""
CFB source — a static GitHub-hosted archive for the bulk of history, live
collegefootballdata.com (CFBD) API calls only for what the archive can't cover.

Coverage: 1869+. Pre-1978 the `division` parameter is meaningless (there were
no formal divisions), so we filter by an FBS-equivalent membership table. The
table is intentionally aggressive — when in doubt, include the program. The
goal is to keep lineage from bouncing into FCS/D2/D3 programs that the user
considers out of scope.

Rate limit lesson: the free CFBD tier caps at 1,000 requests per CALENDAR
MONTH (per CFBD's own key-issuance email), not a per-minute/burst throttle —
confirmed live after two runs stalled on sustained 429s at the same year, 18
hours apart. A single from-scratch historical pull needs ~314 requests
(1869-present x regular/postseason), which alone is a third of the monthly
budget; repeated same-day debugging of this exact fetch exhausted the rest.

Fix: the sportsdataverse/cfbfastR project (the same "gather once" pattern
already used for NFL/NBA in this repo) publishes CFBD's own game data as
static per-season CSVs on GitHub — no API key, no rate limit, same schema
CFBD returns live:
    https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_<year>.csv
This covers ARCHIVE_MIN_YEAR (2001) through whatever season the project has
last published (typically becomes available once that season wraps). Only
1869-2000 (pre-archive) and the newest not-yet-archived season still need the
live CFBD API — roughly ~264 requests once for the pre-2001 range (cached
forever after) plus ~2/day for the current season top-up, comfortably under
the monthly cap even from a cold cache.

Response shape (per CFBD docs, /games endpoint — identical for the archive
CSV and the live API):
    [
      {
        "id": 401403867,
        "season": 2022,
        "season_type": "regular",
        "start_date": "2022-08-27T15:30:00.000Z",
        "home_team": "Nebraska",
        "home_points": 28,
        "away_team": "Northwestern",
        "away_points": 31,
        ...
      },
      ...
    ]

Field-name notes: CFBD has used both snake_case and camelCase historically; the
adapter checks both. We treat home_points / away_points as the canonical fields
and fall back to homePoints / awayPoints.
"""

from __future__ import annotations

import csv
import io
import json
import os
import time
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm
from sources.util import cache_is_complete

SEED_TEAM = norm("Princeton")
SEED_DATE = "1869-11-06"

CFBD_URL = "https://api.collegefootballdata.com/games"
RATE_DELAY_SEC = 0.25  # be polite

ARCHIVE_URL = ("https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/"
               "main/schedules/csv/cfb_schedules_{year}.csv")
ARCHIVE_MIN_YEAR = 2001  # earliest season the cfbfastR-data archive publishes

# Programs we want to count toward the lineal-FBS lineage in pre-1978 years.
# This includes all current FBS members + the major pre-1978 independents and
# conferences that played at the top level. Expand carefully — adding a program
# rewrites lineage from the year they first appear.
PRE_1978_FBS_PROGRAMS = {
    norm(x) for x in [
        # Ivies (top-tier through 1950s)
        "Harvard", "Yale", "Princeton", "Cornell", "Penn", "Columbia",
        "Dartmouth", "Brown",
        # Big Ten (and predecessors)
        "Michigan", "Ohio State", "Penn State", "Michigan State", "Wisconsin",
        "Minnesota", "Iowa", "Illinois", "Indiana", "Northwestern", "Purdue",
        "Nebraska", "Chicago",
        # SEC
        "Alabama", "Auburn", "Georgia", "Florida", "Tennessee", "Kentucky",
        "Vanderbilt", "Mississippi State", "Mississippi", "LSU", "Arkansas",
        "Texas A&M", "South Carolina", "Missouri", "Texas",
        "Tulane", "Sewanee", "Georgia Tech",
        # ACC / former Southern Conf
        "Clemson", "NC State", "North Carolina", "Wake Forest", "Duke",
        "Virginia", "Virginia Tech", "Maryland", "Boston College",
        "Pittsburgh", "Syracuse", "Louisville", "Miami", "Florida State",
        # Big 12 / SWC
        "Oklahoma", "Oklahoma State", "Kansas", "Kansas State", "Iowa State",
        "Baylor", "TCU", "Texas Tech", "Rice", "Houston", "SMU",
        "West Virginia", "BYU", "Cincinnati", "UCF",
        # Pac (and Pac-8/10/12 lineage)
        "USC", "UCLA", "California", "Stanford", "Washington", "Washington State",
        "Oregon", "Oregon State", "Arizona", "Arizona State", "Colorado", "Utah",
        # Independents / others at top level pre-1978
        "Notre Dame", "Army", "Navy", "Air Force", "Boston University",
        "Cincinnati", "Carlisle", "Lafayette", "Lehigh", "Bucknell",
        # Group of 5 modern but historically FBS-equivalent
        "Memphis", "Tulsa", "SMU", "Temple", "Wichita", "Detroit",
        "Marquette", "Fordham", "NYU", "St. Mary's (CA)", "Santa Clara",
        "Loyola Marymount", "USF", "Loyola (LA)",
    ]
}


def _api_key() -> str:
    k = os.environ.get("CFBD_API_KEY")
    if not k:
        raise RuntimeError(
            "CFBD_API_KEY env var is required. Get one free at "
            "https://collegefootballdata.com/key (it's the same key the Worker uses)."
        )
    return k


def _cached_year(cache_dir: Path, year: int, season_type: str) -> Optional[list]:
    f = cache_dir / f"{year}-{season_type}.json"
    # Postseason spills into January of the next year (CFP championship);
    # only trust a cached file once its window can no longer grow.
    window_end = f"{year}-12-20" if season_type == "regular" else f"{year + 1}-01-31"
    if cache_is_complete(f, window_end):
        try:
            return json.loads(f.read_text())
        except Exception:
            return None
    return None


def _save_year(cache_dir: Path, year: int, season_type: str, data: list) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{year}-{season_type}.json").write_text(json.dumps(data))


def _fetch_year(year: int, season_type: str, cache_dir: Path, _tries: int = 0) -> list:
    cached = _cached_year(cache_dir, year, season_type)
    if cached is not None:
        return cached

    params = {"year": year, "seasonType": season_type}
    if year >= 1978:
        params["division"] = "fbs"

    r = requests.get(
        CFBD_URL,
        params=params,
        headers={"Authorization": f"Bearer {_api_key()}", "Accept": "application/json"},
        timeout=30,
    )
    if r.status_code == 429:
        # Short, cheap retry only — CFBD's free tier is a 1,000/calendar-month
        # cap, not a burst throttle, so a persistent 429 almost always means
        # the month's quota is gone and no amount of backoff will change that.
        # A long escalating backoff here just burns CI minutes for nothing
        # (previously up to 75s/year, 6.5h worst case across a full history).
        if _tries >= 1:
            raise RuntimeError(f"CFBD rate-limited {year} {season_type} after {_tries + 1} tries")
        time.sleep(3)
        return _fetch_year(year, season_type, cache_dir, _tries + 1)
    if r.status_code in (401, 403):
        # Auth/quota failure — retrying other years won't help either.
        raise RuntimeError(f"CFBD auth/quota error {r.status_code} for {year} {season_type}: {r.text[:200]}")
    r.raise_for_status()
    data = r.json() or []
    _save_year(cache_dir, year, season_type, data)
    time.sleep(RATE_DELAY_SEC)
    return data


def _archive_cache_path(cache_dir: Path, year: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"archive-{year}.csv"


def _fetch_archive_year(year: int, cache_dir: Path) -> Optional[list[dict]]:
    """Static per-season CSV from the cfbfastR-data archive — no API key, no
    rate limit. Returns None (not raises) if the year isn't archived yet, so
    the caller can fall back to the live CFBD API for that one year only."""
    cf = _archive_cache_path(cache_dir, year)
    window_end = f"{year + 1}-01-31"  # postseason can spill into January
    if cache_is_complete(cf, window_end):
        text = cf.read_text(encoding="utf-8")
    else:
        r = requests.get(ARCHIVE_URL.format(year=year), timeout=30)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        text = r.text
        cf.write_text(text, encoding="utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def _is_fbs_equivalent(team_name: str, year: int) -> bool:
    if year >= 1978:
        return True  # CFBD already filtered division=fbs upstream
    return norm(team_name) in PRE_1978_FBS_PROGRAMS


def _extract_game(it: dict, y: int, start: str, end: str, filter_division: bool) -> Optional[Game]:
    home = it.get("home_team") or it.get("homeTeam")
    away = it.get("away_team") or it.get("awayTeam")
    if not home or not away:
        return None
    if not _is_fbs_equivalent(home, y) or not _is_fbs_equivalent(away, y):
        return None
    if filter_division:
        # Archive CSVs include every division; CFBD's live division=fbs param
        # already narrows this on the API path, so only needed here.
        hd = (it.get("home_division") or "").strip().lower()
        ad = (it.get("away_division") or "").strip().lower()
        if hd != "fbs" or ad != "fbs":
            return None

    hp = it.get("home_points")
    if hp in (None, "", "NA"):
        hp = it.get("homePoints")
    ap = it.get("away_points")
    if ap in (None, "", "NA"):
        ap = it.get("awayPoints")
    if hp in (None, "", "NA") or ap in (None, "", "NA"):
        return None  # game not finished / no score recorded

    date_str = it.get("start_date") or it.get("startDate") or f"{y}-09-01T00:00:00Z"
    if date_str[:10] < start or date_str[:10] > end:
        return None

    gid = it.get("id") or it.get("game_id")
    return Game(
        id=f"CFBD-{gid}",
        date=date_str,
        home_id=norm(home),
        away_id=norm(away),
        home_score=int(float(hp)),
        away_score=int(float(ap)),
    )


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = int(start[:4])
    y1 = int(end[:4])
    out: list[Game] = []
    consecutive_failures = 0
    total_failures = 0
    archive_years = 0

    for y in range(y0, y1 + 1):
        archive_items: Optional[list[dict]] = None
        if y >= ARCHIVE_MIN_YEAR:
            try:
                archive_items = _fetch_archive_year(y, cache_dir)
            except Exception as exc:
                print(f"  cfbfastR-data archive {y}: {exc} — falling back to live CFBD",
                      flush=True)

        if archive_items is not None:
            archive_years += 1
            consecutive_failures = 0
            for it in archive_items:
                g = _extract_game(it, y, start, end, filter_division=True)
                if g is not None:
                    out.append(g)
            continue

        # Not archived (pre-2001, or the newest not-yet-published season) —
        # live CFBD API, same as before.
        for season_type in ("regular", "postseason"):
            try:
                items = _fetch_year(y, season_type, cache_dir)
                consecutive_failures = 0
            except Exception as exc:
                total_failures += 1
                consecutive_failures += 1
                print(f"  CFBD {y} {season_type}: {exc}", flush=True)
                if consecutive_failures >= 3:
                    print(f"  CFB: {consecutive_failures} consecutive CFBD failures — "
                          f"stopping early ({len(out)} games fetched so far, "
                          f"{total_failures} total failures)", flush=True)
                    return out
                continue

            for it in items:
                g = _extract_game(it, y, start, end, filter_division=False)
                if g is not None:
                    out.append(g)

        if y % 20 == 0 or y == y1:
            print(f"  CFBD: through {y} — {len(out)} games, {total_failures} failures so far",
                  flush=True)

    print(f"  CFB: {len(out)} games ({archive_years} seasons from the cfbfastR-data archive, "
          f"rest from live CFBD)", flush=True)
    return out
