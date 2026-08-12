"""
CFB source — collegefootballdata.com /games endpoint.

Stable JSON API; user already has CFBD_API_KEY for the Worker, reuse it here.

Coverage: 1869+. Pre-1978 the `division` parameter is meaningless (there were
no formal divisions), so we filter by an FBS-equivalent membership table. The
table is intentionally aggressive — when in doubt, include the program. The
goal is to keep lineage from bouncing into FCS/D2/D3 programs that the user
considers out of scope.

Response shape (per CFBD docs, /games endpoint):
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
        # Bounded backoff — never loop forever on a persistent rate limit
        # (that once hung a cold rebuild until the CI job timeout).
        if _tries >= 5:
            raise RuntimeError(f"CFBD rate-limited {year} {season_type} after {_tries} retries")
        time.sleep(5 * (_tries + 1))
        return _fetch_year(year, season_type, cache_dir, _tries + 1)
    if r.status_code in (401, 403):
        # Auth/quota failure — retrying other years won't help either.
        raise RuntimeError(f"CFBD auth/quota error {r.status_code} for {year} {season_type}: {r.text[:200]}")
    r.raise_for_status()
    data = r.json() or []
    _save_year(cache_dir, year, season_type, data)
    time.sleep(RATE_DELAY_SEC)
    return data


def _is_fbs_equivalent(team_name: str, year: int) -> bool:
    if year >= 1978:
        return True  # CFBD already filtered division=fbs upstream
    return norm(team_name) in PRE_1978_FBS_PROGRAMS


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = int(start[:4])
    y1 = int(end[:4])
    out: list[Game] = []
    consecutive_failures = 0
    total_failures = 0

    for y in range(y0, y1 + 1):
        for season_type in ("regular", "postseason"):
            try:
                items = _fetch_year(y, season_type, cache_dir)
                consecutive_failures = 0
            except Exception as exc:
                total_failures += 1
                consecutive_failures += 1
                print(f"  CFBD {y} {season_type}: {exc}", flush=True)
                if consecutive_failures >= 6:
                    print(f"  CFB: {consecutive_failures} consecutive CFBD failures — "
                          f"stopping early ({len(out)} games fetched so far, "
                          f"{total_failures} total failures)", flush=True)
                    return out
                continue

            for it in items:
                home = it.get("home_team") or it.get("homeTeam")
                away = it.get("away_team") or it.get("awayTeam")
                if not home or not away:
                    continue
                # Pre-1978 FBS filter
                if not _is_fbs_equivalent(home, y) or not _is_fbs_equivalent(away, y):
                    continue

                hp = it.get("home_points")
                if hp is None:
                    hp = it.get("homePoints")
                ap = it.get("away_points")
                if ap is None:
                    ap = it.get("awayPoints")
                if hp is None or ap is None:
                    continue  # game not finished / no score recorded

                date_str = (
                    it.get("start_date")
                    or it.get("startDate")
                    or f"{y}-09-01T00:00:00Z"
                )
                if date_str[:10] < start or date_str[:10] > end:
                    continue

                out.append(
                    Game(
                        id=f"CFBD-{it.get('id')}",
                        date=date_str,
                        home_id=norm(home),
                        away_id=norm(away),
                        home_score=int(hp),
                        away_score=int(ap),
                    )
                )

        if y % 20 == 0 or y == y1:
            print(f"  CFBD: through {y} — {len(out)} games, {total_failures} failures so far",
                  flush=True)

    return out
