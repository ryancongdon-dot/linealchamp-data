"""
EPL source — balldontlie /epl/v1/games with a shape probe step.

The existing Worker bug is real: the EPL adapter expects 'home_team' /
'away_team' but BDL may actually be using 'visitor_team' for the road team
(like the NBA/NFL endpoints). We don't have access to test the live API from
the development sandbox, so this module is written to handle BOTH shapes and
log which one was actually present. Run the probe first to find out:

    python build_lineage.py --probe EPL --year 2023

URL: https://api.balldontlie.io/epl/v1/games
Auth: Bearer (same key as NBA/NFL endpoints)

Likely response shape (one game), with field uncertainty noted:
    {
      "id": 12345,
      "date" | "start_time" | "start": "2023-08-12T11:30:00Z",
      "season": 2023,
      "home_team":    { "abbreviation"|"short_code"|"full_name"|"name": "..." },
      "away_team"|"visitor_team": { ...same shape... },
      "home_team_score"|"home_score":  2,
      "away_team_score"|"visitor_team_score"|"away_score": 1,
      "status": "Final"
    }

We try every variant. The first one with usable data wins. If a season returns
no games AT ALL, we log loudly so you know to either re-check the API key, hit
the probe endpoint to see the live shape, or fall back to fbref scraping.

EPL "as a league" started 1992. Pre-1992 English top-flight was Division One;
those seasons are out of scope unless you change SEED_DATE.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm

SEED_TEAM = norm("Leeds United")  # 1991-92 Division One champions; last pre-EPL champs
SEED_DATE = "1992-08-15"

BDL_EPL_URL = "https://api.balldontlie.io/epl/v1/games"
RATE_DELAY_SEC = 0.6


def _api_key() -> str:
    k = os.environ.get("BDL_API_KEY")
    if not k:
        raise RuntimeError("BDL_API_KEY env var required for EPL source.")
    return k


def _cache_path(cache_dir: Path, season: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"season-{season}.json"


def _fetch_season(season: int, cache_dir: Path) -> list[dict]:
    cf = _cache_path(cache_dir, season)
    if cf.exists():
        try:
            return json.loads(cf.read_text())
        except Exception:
            pass

    all_items: list[dict] = []
    cursor: Optional[str] = None
    safety = 0
    while True:
        params = {
            "per_page": "100",
            "seasons[]": str(season),
        }
        if cursor is not None:
            params["cursor"] = str(cursor)
        r = requests.get(
            BDL_EPL_URL,
            params=params,
            headers={
                "Authorization": f"Bearer {_api_key()}",
                "Accept": "application/json",
            },
            timeout=30,
        )
        if r.status_code == 429:
            time.sleep(8)
            continue
        if r.status_code in (401, 403):
            raise RuntimeError(
                f"BDL EPL returned {r.status_code} — your BDL_API_KEY may not have "
                f"the EPL endpoint enabled (it's a paid tier on some plans). "
                f"Response: {r.text[:200]}"
            )
        r.raise_for_status()
        j = r.json()
        all_items.extend(j.get("data", []))
        nxt = (j.get("meta") or {}).get("next_cursor")
        if not nxt:
            break
        cursor = nxt
        safety += 1
        if safety > 2000:
            break
        time.sleep(RATE_DELAY_SEC)
    cf.write_text(json.dumps(all_items))
    return all_items


def _team_id(team: dict) -> str:
    if not team:
        return ""
    for key in ("abbreviation", "short_code", "full_name", "name"):
        v = team.get(key)
        if v:
            return norm(v)
    return ""


def _away_team(it: dict) -> dict:
    """BDL EPL uses one of: away_team, visitor_team. Try both."""
    return it.get("away_team") or it.get("visitor_team") or {}


def _score_pair(it: dict) -> tuple[Optional[int], Optional[int]]:
    """Return (home_score, away_score), trying every known field name."""
    h = it.get("home_team_score")
    if h is None:
        h = it.get("home_score")
    if h is None:
        h = it.get("home_goals")
    a = (
        it.get("away_team_score")
        or it.get("visitor_team_score")
        or it.get("away_score")
        or it.get("away_goals")
    )
    return h, a


def _date_str(it: dict) -> Optional[str]:
    for k in ("date", "start_time", "start", "kickoff", "scheduled"):
        v = it.get(k)
        if v:
            return v
    return None


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = max(1992, int(start[:4]))
    y1 = int(end[:4])
    out: list[Game] = []
    for season in range(y0, y1 + 1):
        try:
            items = _fetch_season(season, cache_dir)
        except Exception as exc:
            print(f"  EPL season {season} fetch failed: {exc}", flush=True)
            continue

        before = len(out)
        for it in items:
            home_id = _team_id(it.get("home_team") or {})
            away_id = _team_id(_away_team(it))
            if not home_id or not away_id:
                continue
            hs, as_ = _score_pair(it)
            if hs is None or as_ is None:
                continue
            d = _date_str(it) or f"{season}-08-01"
            iso_d = d if "T" in d else f"{d}T00:00:00Z"
            if not (start <= iso_d[:10] <= end):
                continue
            try:
                out.append(
                    Game(
                        id=f"BDL-EPL-{it.get('id')}",
                        date=iso_d,
                        home_id=home_id,
                        away_id=away_id,
                        home_score=int(hs),
                        away_score=int(as_),
                    )
                )
            except (TypeError, ValueError):
                continue

        added = len(out) - before
        print(f"  EPL season {season}: {added} games (raw: {len(items)})", flush=True)
        if added == 0 and len(items) > 0:
            # The fetch worked but our parser found nothing usable — dump one
            # raw item so the user can see what shape actually came back.
            print(f"    ⚠ raw item shape: {json.dumps(items[0], indent=2)[:500]}", flush=True)

    return out
