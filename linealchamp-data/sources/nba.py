"""
NBA source — FiveThirtyEight's committed game log (a single CSV we own).

Why this instead of balldontlie: balldontlie's free tier rate-limits a cold
full-history rebuild so hard it never finishes (a 2.5-hour run produced nothing).
This source instead reads FiveThirtyEight's `nbaallelo.csv` — every BAA/NBA/ABA
game from 1946 through the 2015 Finals, one flat CSV on GitHub. Frozen, so no
rate limits and identical every run ("gather once, own the file").

    https://github.com/fivethirtyeight/data  (nba-elo/nbaallelo.csv)

Notes on the format:
    - Every game appears TWICE (once per team); `_iscopy == 0` is the primary
      row, so we keep only those to avoid double-counting.
    - We use `fran_id` / `opp_fran` (franchise identity: "Warriors", "Lakers")
      rather than the season team code, so a franchise keeps one lineal identity
      across relocations — the whole point of "the man who beat the man".
    - `date_game` is M/D/YYYY; `pts` / `opp_pts` are final scores (no ties).

Coverage ends with the 2015 Finals (538's data is frozen there), so the NBA
"current" champion is as of June 2015; recent seasons can be spliced on later.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from pathlib import Path

import requests

from lineage import Game, norm

# Philadelphia Warriors — 1947 BAA Finals winner (the "Warriors" franchise).
SEED_TEAM = norm("Warriors")
SEED_DATE = "1947-04-22"

CSV_URL = "https://raw.githubusercontent.com/fivethirtyeight/data/master/nba-elo/nbaallelo.csv"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}

_TEAM_NAMES: dict[str, str] = {}


def _cache_path(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "nbaallelo.csv"


def _load_csv(cache_dir: Path) -> str:
    cf = _cache_path(cache_dir)
    if cf.exists() and cf.stat().st_size > 0:  # frozen file — cache never goes stale
        return cf.read_text(encoding="utf-8")
    r = requests.get(CSV_URL, headers=HEADERS, timeout=120)
    r.raise_for_status()
    cf.write_text(r.text, encoding="utf-8")
    return r.text


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    text = _load_csv(cache_dir)
    out: list[Game] = []
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("_iscopy") != "0":   # keep one row per game
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
        h_id, a_id = norm(fran), norm(opp)
        _TEAM_NAMES[h_id] = fran
        _TEAM_NAMES[a_id] = opp
        out.append(Game(id=(row.get("game_id") or f"NBA-{iso}-{h_id}-{a_id}"),
                        date=f"{iso}T00:00:00Z",
                        home_id=h_id, away_id=a_id, home_score=pts, away_score=opp_pts))
    print(f"  NBA: {len(out)} games from 538 nbaallelo.csv", flush=True)
    return out


def team_brand() -> dict:
    """Display-name map — franchise nicknames are already human-readable."""
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
