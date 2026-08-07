"""
NFL source — two committed feeds spliced into one continuous history.

The lineal chain must run unbroken from 1920, AND stay current after each week's
games. No single free source does both, so we splice two:

  * 1920 - 1998  →  FiveThirtyEight `nfl_games.csv` (frozen; deep history that
                    never changes, so it's cached once).
  * 1999 - today →  nflverse `games.csv` (github.com/nflverse/nfldata), which is
                    updated after every game — fetched fresh each run so the
                    daily refresh keeps the belt current.

pro-football-reference (the old scraper) 403s automated requests, which is why
both feeds are GitHub-hosted CSVs instead.

Franchise continuity: 538 uses franchise-stable codes; nflverse uses city codes
that change on relocation. We canonicalize the moved franchises so a team keeps
one lineal identity across the 1999 seam and across later moves
(STL/LA→LAR, SD→LAC, LV→OAK, WAS→WSH).
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import requests

from lineage import Game, norm

# Akron Pros — 1920 APFA inaugural champion, the conventional NFL lineal seed.
SEED_TEAM = norm("AKR")
SEED_DATE = "1920-09-26"

# The 1999 NFL season starts in September; this cleanly splits the two feeds
# (538 covers through the 1998 season, ending ~Feb 1999).
SPLICE = "1999-08-01"

CSV_538 = "https://raw.githubusercontent.com/fivethirtyeight/nfl-elo-game/master/data/nfl_games.csv"
CSV_NFLVERSE = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}

# Relocated-franchise codes -> one canonical (538-style) franchise code.
CANON = {"LA": "LAR", "STL": "LAR", "SD": "LAC", "LV": "OAK", "WAS": "WSH"}


def _canon(code: str) -> str:
    c = (code or "").strip().upper()
    return CANON.get(c, c)


# Canonical franchise code -> display name (modern 32 + historical belt-holders).
NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LAC": "Los Angeles Chargers", "LAR": "Los Angeles Rams",
    "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings", "NE": "New England Patriots",
    "NO": "New Orleans Saints", "NYG": "New York Giants", "NYJ": "New York Jets",
    "OAK": "Las Vegas Raiders", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WSH": "Washington Commanders",
    "AKR": "Akron Pros", "BFF": "Buffalo All-Americans", "BKN": "Brooklyn Dodgers",
    "BYK": "Brooklyn Yankees", "CBD": "Canton Bulldogs", "CIB": "Cleveland Bulldogs",
    "DAY": "Dayton Triangles", "DTX": "Dallas Texans", "FYJ": "Frankford Yellow Jackets",
    "NYA": "New York Yankees (NFL)", "NYY": "New York Yanks", "PRV": "Providence Steam Roller",
    "PTB": "Pottsville Maroons", "RII": "Rock Island Independents", "STG": "Phil-Pitt Steagles",
    "COL": "Columbus Tigers", "RAC": "Racine Legion", "MIL": "Milwaukee Badgers",
    "DUL": "Duluth Eskimos", "HAM": "Hammond Pros", "TOL": "Toledo Maroons",
}

_TEAM_NAMES: dict[str, str] = {}


def _record(code: str, raw: str) -> str:
    _TEAM_NAMES[code] = NAMES.get(code, raw)
    return code


def _load_538(cache_dir: Path) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf = cache_dir / "nfl_games.csv"
    if cf.exists() and cf.stat().st_size > 0:   # frozen — cache forever
        return cf.read_text(encoding="utf-8")
    r = requests.get(CSV_538, headers=HEADERS, timeout=90); r.raise_for_status()
    cf.write_text(r.text, encoding="utf-8")
    return r.text


def _load_nflverse() -> str:
    # Always fetched fresh — this feed updates after every game.
    r = requests.get(CSV_NFLVERSE, headers=HEADERS, timeout=90); r.raise_for_status()
    return r.text


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out: list[Game] = []
    lo, hi = start[:10], end[:10]

    # 1920–1998 from 538 (only if the requested window reaches that far back).
    if lo < SPLICE:
        for i, r in enumerate(csv.DictReader(io.StringIO(_load_538(cache_dir)))):
            d = (r.get("date") or "")[:10]
            if not d or d >= SPLICE or not (lo <= d <= hi):
                continue
            try:
                hs, as_ = int(r["score1"]), int(r["score2"])
            except (ValueError, KeyError):
                continue
            h = _record(_canon(r["team1"]), r["team1"])
            a = _record(_canon(r["team2"]), r["team2"])
            out.append(Game(id=f"FTE-NFL-{i}", date=f"{d}T00:00:00Z",
                            home_id=h, away_id=a, home_score=hs, away_score=as_))

    # 1999–today from nflverse (completed games only; future rows have no score).
    try:
        nv = _load_nflverse()
    except Exception as exc:
        print(f"  NFL: nflverse fetch failed ({exc}); using 538 history only", flush=True)
        nv = ""
    if nv:
        for r in csv.DictReader(io.StringIO(nv)):
            d = (r.get("gameday") or "")[:10]
            if not d or d < SPLICE or not (lo <= d <= hi):
                continue
            hs, as_ = (r.get("home_score") or "").strip(), (r.get("away_score") or "").strip()
            if hs == "" or as_ == "":
                continue
            try:
                hs, as_ = int(hs), int(as_)
            except ValueError:
                continue
            h = _record(_canon(r["home_team"]), r["home_team"])
            a = _record(_canon(r["away_team"]), r["away_team"])
            out.append(Game(id=(r.get("game_id") or f"NFLV-{d}-{h}-{a}"),
                            date=f"{d}T00:00:00Z",
                            home_id=h, away_id=a, home_score=hs, away_score=as_))

    print(f"  NFL: {len(out)} games (538 pre-1999 + nflverse 1999→today)", flush=True)
    return out


def team_brand() -> dict:
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
