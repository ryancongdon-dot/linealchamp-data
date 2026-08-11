"""
NBA source — two feeds spliced into one continuous, self-updating history.

The lineal chain must run unbroken from 1946 AND stay current after each
night's games. No single free source does both, so we splice two:

  * 1946 - 2015 Finals →  FiveThirtyEight `nbaallelo.csv` (frozen; deep history
                          that never changes, cached once).
  * 2015 Finals - today →  balldontlie's `/v1/games`, fetched fresh each run.

Why not ESPN for the recent half: tried first, and its site API turned out to
be blocked from BOTH this dev environment and GitHub Actions runners (a fetch
logged "8 consecutive ESPN request failures" in ~5 seconds — a real network
block, not a fluke). balldontlie is the endpoint the Worker's own live cron
(worker.js fetchNBARecent) already uses successfully every day, so it's
proven reachable — and unlike an earlier balldontlie attempt that tried to
pull NBA's ENTIRE 1946-present history through the free tier's rate limit
(a 2.5-hour run that produced nothing), this only needs the last ~10 years,
which is a much smaller ask, with exponential 429 backoff and a circuit
breaker that bails cleanly rather than hanging.

Requires BDL_API_KEY (a free balldontlie account key) as an env var.

Franchise continuity: 538 uses franchise nicknames ("Warriors", "Lakers");
balldontlie uses team abbreviations. TEAM_MAP translates balldontlie's 30
abbreviations to the matching 538 nickname so a franchise keeps one lineal
identity across the splice.
"""

from __future__ import annotations

import csv
import io
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm
from sources.util import cache_is_complete, get_with_backoff, is_recent, looks_final

# Philadelphia Warriors — 1947 BAA Finals winner (the "Warriors" franchise).
SEED_TEAM = norm("Warriors")
SEED_DATE = "1947-04-22"

# Day after the 2015 Finals (538's nbaallelo.csv ends 2015-06-16).
SPLICE = "2015-06-17"

CSV_538 = "https://raw.githubusercontent.com/fivethirtyeight/data/master/nba-elo/nbaallelo.csv"
BDL_URL = "https://api.balldontlie.io/v1/games"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}
RATE_DELAY_SEC = 0.4

# balldontlie abbreviation -> 538 franchise nickname (all 30 teams, stable
# since 2015; no relocations to canonicalize in this window).
TEAM_MAP = {
    "ATL": "Hawks", "BOS": "Celtics", "BKN": "Nets", "CHA": "Hornets",
    "CHI": "Bulls", "CLE": "Cavaliers", "DAL": "Mavericks", "DEN": "Nuggets",
    "DET": "Pistons", "GSW": "Warriors", "HOU": "Rockets", "IND": "Pacers",
    "LAC": "Clippers", "LAL": "Lakers", "MEM": "Grizzlies", "MIA": "Heat",
    "MIL": "Bucks", "MIN": "Timberwolves", "NOP": "Pelicans", "NYK": "Knicks",
    "OKC": "Thunder", "ORL": "Magic", "PHI": "Sixers", "PHX": "Suns",
    "POR": "Trailblazers", "SAC": "Kings", "SAS": "Spurs", "TOR": "Raptors",
    "UTA": "Jazz", "WAS": "Wizards",
}

_TEAM_NAMES: dict[str, str] = {}


def _record(nickname: str) -> str:
    code = norm(nickname)
    _TEAM_NAMES[code] = nickname
    return code


def _api_key() -> str:
    k = os.environ.get("BDL_API_KEY")
    if not k:
        raise RuntimeError("BDL_API_KEY env var required for NBA's recent-season fetch.")
    return k


def _load_538(cache_dir: Path) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf = cache_dir / "nbaallelo.csv"
    if cf.exists() and cf.stat().st_size > 0:   # frozen — cache forever
        return cf.read_text(encoding="utf-8")
    r = requests.get(CSV_538, headers=HEADERS, timeout=120)
    r.raise_for_status()
    cf.write_text(r.text, encoding="utf-8")
    return r.text


def _fetch_538_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out: list[Game] = []
    for row in csv.DictReader(io.StringIO(_load_538(cache_dir))):
        if row.get("_iscopy") != "0":
            continue
        fran = (row.get("fran_id") or "").strip()
        opp = (row.get("opp_fran") or "").strip()
        dg = (row.get("date_game") or "").strip()
        if not fran or not opp or not dg:
            continue
        try:
            iso = datetime.strptime(dg, "%m/%d/%Y").strftime("%Y-%m-%d")
            pts, opp_pts = int(row["pts"]), int(row["opp_pts"])
        except (ValueError, KeyError):
            continue
        if not (start <= iso <= end):
            continue
        h_id, a_id = _record(fran), _record(opp)
        out.append(Game(id=(row.get("game_id") or f"NBA-{iso}-{h_id}-{a_id}"),
                        date=f"{iso}T00:00:00Z",
                        home_id=h_id, away_id=a_id, home_score=pts, away_score=opp_pts))
    return out


def _bdl_cache_path(cache_dir: Path, year: int, postseason: bool) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"bdl_{year}_{'post' if postseason else 'reg'}.json"


def _fetch_bdl_window(window_start: str, window_end: str, postseason: bool, cache_dir: Path) -> list[dict]:
    cf = _bdl_cache_path(cache_dir, int(window_start[:4]), postseason)
    if cache_is_complete(cf, window_end):
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
            "start_date": window_start,
            "end_date": window_end,
            "postseason": "true" if postseason else "false",
        }
        if cursor is not None:
            params["cursor"] = str(cursor)
        r = get_with_backoff(
            BDL_URL, params,
            headers={"Authorization": f"Bearer {_api_key()}", "Accept": "application/json"},
            label=f"NBA {window_start}",
        )
        r.raise_for_status()
        j = r.json()
        all_items.extend(j.get("data", []))
        nxt = (j.get("meta") or {}).get("next_cursor")
        if not nxt:
            break
        cursor = nxt
        safety += 1
        if safety > 500:
            break
        time.sleep(RATE_DELAY_SEC)
    cf.write_text(json.dumps(all_items))
    return all_items


def _fetch_bdl_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    """Fetch balldontlie in 1-year windows (2015-today, not full history — the
    much larger 1946-present pull is what previously hung for 2.5 hours)."""
    out: list[Game] = []
    consecutive_failures = 0
    y0, y1 = int(start[:4]), int(end[:4])
    for y in range(y0, y1 + 1):
        window_start = max(start, f"{y}-01-01")
        window_end = min(end, f"{y}-12-31")
        for postseason in (False, True):
            try:
                items = _fetch_bdl_window(window_start, window_end, postseason, cache_dir)
                consecutive_failures = 0
            except Exception as exc:
                print(f"  NBA {y} {'post' if postseason else 'reg'}: {exc}", flush=True)
                consecutive_failures += 1
                if consecutive_failures >= 4:
                    print(f"  NBA: {consecutive_failures} consecutive balldontlie window "
                          f"failures — stopping early; cached progress is kept", flush=True)
                    return out
                continue
            for it in items:
                home_team = it.get("home_team") or {}
                vis_team = it.get("visitor_team") or {}
                hs, vs = it.get("home_team_score"), it.get("visitor_team_score")
                if hs is None or vs is None or (hs == 0 and vs == 0):
                    continue
                game_date = it.get("date") or f"{y}-01-01"
                if is_recent(game_date, end) and not looks_final(it.get("status")):
                    continue
                h_abbr = (home_team.get("abbreviation") or "").upper()
                a_abbr = (vis_team.get("abbreviation") or "").upper()
                if h_abbr not in TEAM_MAP or a_abbr not in TEAM_MAP:
                    continue
                h_id, a_id = _record(TEAM_MAP[h_abbr]), _record(TEAM_MAP[a_abbr])
                out.append(Game(id=f"BDL-NBA-{it.get('id')}", date=f"{game_date[:10]}T00:00:00Z",
                                home_id=h_id, away_id=a_id, home_score=int(hs), away_score=int(vs)))
    return out


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out = _fetch_538_games(start, end, cache_dir) if start[:10] < SPLICE else []
    try:
        recent = _fetch_bdl_games(max(start[:10], SPLICE), end[:10], cache_dir)
    except Exception as exc:
        print(f"  NBA: balldontlie fetch failed entirely ({exc}); using 538 history only", flush=True)
        recent = []
    out.extend(recent)
    print(f"  NBA: {len(out)} games (538 pre-2015 Finals + balldontlie 2015→today, "
          f"{len(recent)} from balldontlie)", flush=True)
    return out


def team_brand() -> dict:
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
