"""
NBA source — balldontlie historical /v1/games endpoint.

BDL's NBA endpoint goes back to 1946 (the BAA's first season). Free tier has
strict rate limits; cache aggressively.

URL: https://api.balldontlie.io/v1/games
Auth: Bearer header (header name: Authorization)

Response shape (verified working in the user's existing Worker):
    {
      "data": [
        {
          "id": 12345,
          "date": "2024-04-14",
          "season": 2023,
          "postseason": false,
          "home_team":     { "abbreviation": "BOS", "full_name": "Boston Celtics", ... },
          "visitor_team":  { "abbreviation": "MIL", "full_name": "Milwaukee Bucks", ... },
          "home_team_score": 132,
          "visitor_team_score": 119,
          "status": "Final"
        }
      ],
      "meta": { "next_cursor": 12346 }
    }

Note: 'visitor_team' is the away team, not 'away_team'. The existing Worker
adapter uses this correctly for NBA; the bug was only on the NFL/EPL endpoints
(which we treat separately).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm

SEED_TEAM = norm("PHW")  # Philadelphia Warriors — 1947 BAA Finals winner
SEED_DATE = "1947-04-22"

BDL_URL = "https://api.balldontlie.io/v1/games"
RATE_DELAY_SEC = 0.4


def _api_key() -> str:
    k = os.environ.get("BDL_API_KEY")
    if not k:
        raise RuntimeError("BDL_API_KEY env var required for NBA source.")
    return k


def _cache_path(cache_dir: Path, start: str, end: str, postseason: bool) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    suffix = "post" if postseason else "reg"
    return cache_dir / f"{start}_{end}_{suffix}.json"


def _fetch_window(start: str, end: str, postseason: bool, cache_dir: Path) -> list[dict]:
    cf = _cache_path(cache_dir, start, end, postseason)
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
            "start_date": start,
            "end_date": end,
            "postseason": "true" if postseason else "false",
        }
        if cursor is not None:
            params["cursor"] = str(cursor)
        r = requests.get(
            BDL_URL,
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


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    """
    Fetch in 1-year windows so cache files are reasonably sized and so
    intermittent failures don't blow away a whole decade of work.
    """
    y0 = int(start[:4])
    y1 = int(end[:4])
    out: list[Game] = []
    for y in range(y0, y1 + 1):
        window_start = max(start, f"{y}-01-01")
        window_end = min(end, f"{y}-12-31")
        for postseason in (False, True):
            try:
                items = _fetch_window(window_start, window_end, postseason, cache_dir)
            except Exception as exc:
                print(f"  NBA {y} {'post' if postseason else 'reg'}: {exc}")
                continue
            for it in items:
                home_team = it.get("home_team") or {}
                vis_team = it.get("visitor_team") or {}
                hs = it.get("home_team_score")
                vs = it.get("visitor_team_score")
                if hs is None or vs is None:
                    continue
                # Treat 0-0 unfinished games as missing (status check would be cleaner,
                # but historical BDL data doesn't always populate status reliably).
                if hs == 0 and vs == 0:
                    continue
                out.append(
                    Game(
                        id=f"BDL-NBA-{it.get('id')}",
                        date=it.get("date") or f"{y}-01-01",
                        home_id=norm(home_team.get("abbreviation") or home_team.get("full_name") or "HOME"),
                        away_id=norm(vis_team.get("abbreviation") or vis_team.get("full_name") or "AWAY"),
                        home_score=int(hs),
                        away_score=int(vs),
                    )
                )
        print(f"  NBA {y}: cumulative {len(out)} games", flush=True)
    return out
