"""
NFL source — historical Wikipedia scrape (1933–2001) + balldontlie (2002+).

History:
    pro-football-reference's WAF blocks all non-residential clients, so we
    can't use it. Wikipedia season pages have stable URLs, no WAF, and tables
    going back to 1933 — see sources/nfl_wiki.py.

Strategy:
    The fetch_all_games(start, end, cache_dir) entry point pulls Wikipedia
    data for seasons in [start_year, 2001] and BDL data for [2002, end_year],
    then concatenates them. Both sources emit Game with home_id / away_id
    normalized to the same modern team codes (ARI, ATL, ..., WAS), so the
    lineage walker sees one continuous chain.

Seed:
    The 1933 NFL Championship Game (Chicago Bears 23-21 over NY Giants) is
    the first formal NFL championship. Pre-1933 the league title was awarded
    by standings only, so we start the chain at the first true championship
    game, consistent with the "championship-only seed" rule chosen for the
    other major sports.

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
from sources import nfl_wiki, nfl_supplemental

SEED_TEAM = "CHI"           # 1933 NFL Champion: Chicago Bears
SEED_DATE = "1933-12-17"    # 1933 NFL Championship Game: Bears 23-21 Giants

# Years for which we use Wikipedia (BDL doesn't have them).
WIKI_SEASON_START = 1933
WIKI_SEASON_END = 2001      # BDL takes over from 2002.

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


# BDL uses some team abbreviations that differ from the canonical codes our
# Wikipedia historical scraper uses. Normalize so the same franchise doesn't
# appear as two separate teams across the 2001/2002 data boundary.
BDL_TO_CANONICAL = {
    "WSH": "WAS",   # Washington Commanders (BDL=WSH, Wikipedia=WAS)
}


def _team_id(team: dict) -> str:
    if not team:
        return ""
    for k in ("abbreviation", "short_code", "full_name", "name"):
        v = team.get(k)
        if v:
            code = norm(v)
            return BDL_TO_CANONICAL.get(code, code)
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
    start_year = int(start[:4])
    end_year = int(end[:4])
    out: list[Game] = []

    # ── Wikipedia: 1933 .. 2001 (cached per-season). ────────────────────────
    wiki_start = max(start_year, WIKI_SEASON_START)
    wiki_end = min(end_year, WIKI_SEASON_END)
    wiki_cache = cache_dir / "wiki"
    if wiki_start <= wiki_end:
        for g in nfl_wiki.fetch_seasons(wiki_start, wiki_end, wiki_cache):
            if start <= g.date[:10] <= end:
                out.append(g)

    # ── BDL: 2002 .. end_year. ──────────────────────────────────────────────
    bdl_y0 = max(2002, start_year)
    for season in range(bdl_y0, end_year + 1):
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

    # ── Supplemental: hand-curated pre-merger NFL Championships ─────────────
    # These get added LAST so the per-key dedup below keeps the hand-curated
    # game when the scraper happens to have caught the same matchup.
    supp_added = 0
    for g in nfl_supplemental.supplemental_games():
        if start <= g.date[:10] <= end:
            out.append(g)
            supp_added += 1
    print(f"  NFL supplemental: added {supp_added} curated championships", flush=True)

    # Dedupe by (date, frozenset({teams})). Keeps the LAST occurrence so the
    # hand-curated supplemental wins if the scraper ever catches up.
    by_key: dict[tuple[str, frozenset[str]], Game] = {}
    for g in out:
        key = (g.date[:10], frozenset({g.home_id, g.away_id}))
        by_key[key] = g
    return list(by_key.values())
