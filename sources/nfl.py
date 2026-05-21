"""
NFL source — balldontlie /nfl/v1/games.

We originally tried pro-football-reference scraping for full 1920+ history, but
PFR's WAF blocks all non-residential clients (including Mozilla UAs) with a
hard 403, so we fall back to BDL which only covers 2002+. Lineage starts there.

BDL NFL game shape (matches NBA shape):
    {
      "id": ...,
      "date": "2023-09-07",
      "season": 2023,
      "home_team":    { "abbreviation": "KC", ... },
      "visitor_team": { "abbreviation": "DET", ... },
      "home_team_score": 21,
      "visitor_team_score": 20,
      ...
    }
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm

SEED_TEAM = None  # first-game-winner; with SEED_DATE = Super Bowl XXXVII
SEED_DATE = "2003-01-26"  # SB XXXVII (Tampa Bay Buccaneers); first championship in BDL data

BDL_URL = "https://api.balldontlie.io/nfl/v1/games"
RATE_DELAY_SEC = 0.5


def _api_key() -> str:
    k = os.environ.get("BDL_API_KEY")
    if not k:
        raise RuntimeError("BDL_API_KEY env var required for NFL source.")
    return k


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Accept": "application/json",
    }


def _fetch_season(season: int, cache_dir: Path) -> list[dict]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf = cache_dir / f"season-{season}.json"
    if cf.exists() and cf.stat().st_size > 100:
        try:
            return json.loads(cf.read_text())
        except Exception:
            pass

    all_items: list[dict] = []
    cursor: Optional[str] = None
    safety = 0
    while True:
        params = {"per_page": "100", "seasons[]": str(season)}
        if cursor is not None:
            params["cursor"] = str(cursor)
        r = requests.get(BDL_URL, params=params, headers=_headers(), timeout=30)
        if r.status_code == 429:
            time.sleep(8)
            continue
        if r.status_code in (401, 403):
            raise RuntimeError(
                f"BDL NFL {r.status_code} — your BDL plan may not include NFL. "
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
        if safety > 200:
            break
        time.sleep(RATE_DELAY_SEC)
    cf.write_text(json.dumps(all_items))
    return all_items


def _team_id(team: dict) -> str:
    if not team:
        return ""
    for k in ("abbreviation", "short_code", "full_name", "name"):
        v = team.get(k)
        if v:
            return norm(v)
    return ""


def _away(it: dict) -> dict:
    return it.get("visitor_team") or it.get("away_team") or {}


def _away_score(it: dict):
    return (
        it.get("visitor_team_score")
        if it.get("visitor_team_score") is not None
        else it.get("away_team_score")
    )


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = max(2002, int(start[:4]))
    y1 = int(end[:4])
    out: list[Game] = []
    for season in range(y0, y1 + 1):
        try:
            items = _fetch_season(season, cache_dir)
        except Exception as exc:
            print(f"  NFL season {season} fetch failed: {exc}", flush=True)
            continue

        kept = 0
        for it in items:
            home_id = _team_id(it.get("home_team") or {})
            away_id = _team_id(_away(it))
            if not home_id or not away_id:
                continue
            hs = it.get("home_team_score")
            as_ = _away_score(it)
            if hs is None or as_ is None:
                continue
            if hs == 0 and as_ == 0:
                continue
            d = it.get("date") or f"{season}-09-01"
            iso_d = d if "T" in d else f"{d}T00:00:00Z"
            if not (start <= iso_d[:10] <= end):
                continue
            try:
                out.append(
                    Game(
                        id=f"BDL-NFL-{it.get('id')}",
                        date=iso_d,
                        home_id=home_id,
                        away_id=away_id,
                        home_score=int(hs),
                        away_score=int(as_),
                    )
                )
                kept += 1
            except (TypeError, ValueError):
                continue

        print(f"  NFL season {season}: kept {kept} of {len(items)} games", flush=True)

    return out
