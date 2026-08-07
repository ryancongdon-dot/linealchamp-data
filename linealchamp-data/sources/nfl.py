"""
NFL source — FiveThirtyEight's committed game log (a single CSV we own).

Why this instead of scraping pro-football-reference: PFR now returns HTTP 403
to automated requests, so the old scraper could not fetch a single season. This
source instead reads FiveThirtyEight's `nfl_games.csv` — every NFL/APFA game
from 1920 through Super Bowl LV (Feb 2021), one flat CSV hosted on GitHub. It is
frozen (538 stopped updating), which is exactly what we want for a "gather once,
own the file" backfill: no rate limits, no blocking, identical every run.

    https://github.com/fivethirtyeight/nfl-elo-game  (data/nfl_games.csv)

Columns used:
    date    YYYY-MM-DD
    team1   3-letter team code   (home / first team)
    team2   3-letter team code   (away / second team)
    score1  team1 final points
    score2  team2 final points

The lineal winner is just the higher score (ties retain the belt), so we map
team1 -> home and team2 -> away and let lineage.py do the rest. Team codes are
538's stable franchise codes; team_brand() maps them to real names for display.
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

CSV_URL = "https://raw.githubusercontent.com/fivethirtyeight/nfl-elo-game/master/data/nfl_games.csv"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}

# 538 team code -> display name. Covers the modern 32 plus every franchise that
# ever held the lineal belt; obscure 1920s one-off clubs fall back to their code.
NAMES = {
    # Modern 32
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
    # Historical belt-holders
    "AKR": "Akron Pros", "BFF": "Buffalo All-Americans", "BKN": "Brooklyn Dodgers",
    "BYK": "Brooklyn Yankees", "CBD": "Canton Bulldogs", "CIB": "Cleveland Bulldogs",
    "DAY": "Dayton Triangles", "DTX": "Dallas Texans", "FYJ": "Frankford Yellow Jackets",
    "NYA": "New York Yankees (NFL)", "NYY": "New York Yanks", "PRV": "Providence Steam Roller",
    "PTB": "Pottsville Maroons", "RII": "Rock Island Independents", "STG": "Phil-Pitt Steagles",
    # Common older opponents
    "COL": "Columbus Tigers", "RAC": "Racine Legion", "MIL": "Milwaukee Badgers",
    "DUL": "Duluth Eskimos", "HAM": "Hammond Pros", "TOL": "Toledo Maroons",
    "KCB": "Kansas City Blues", "HRT": "Hartford Blues", "PTQ": "Pottsville Maroons",
}

_TEAM_NAMES: dict[str, str] = {}


def _cache_path(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "nfl_games.csv"


def _load_csv(cache_dir: Path) -> str:
    cf = _cache_path(cache_dir)
    # The 538 file is frozen, so once cached it never needs re-fetching.
    if cf.exists() and cf.stat().st_size > 0:
        return cf.read_text(encoding="utf-8")
    r = requests.get(CSV_URL, headers=HEADERS, timeout=90)
    r.raise_for_status()
    text = r.text
    cf.write_text(text, encoding="utf-8")
    return text


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    text = _load_csv(cache_dir)
    out: list[Game] = []
    reader = csv.DictReader(io.StringIO(text))
    for i, row in enumerate(reader):
        date = (row.get("date") or "").strip()
        t1 = (row.get("team1") or "").strip()
        t2 = (row.get("team2") or "").strip()
        s1 = (row.get("score1") or "").strip()
        s2 = (row.get("score2") or "").strip()
        if not date or not t1 or not t2 or s1 == "" or s2 == "":
            continue
        if not (start <= date[:10] <= end):
            continue
        try:
            hs, as_ = int(s1), int(s2)
        except ValueError:
            continue
        h_id, a_id = norm(t1), norm(t2)
        _TEAM_NAMES[h_id] = NAMES.get(h_id, t1)
        _TEAM_NAMES[a_id] = NAMES.get(a_id, t2)
        out.append(Game(id=f"FTE-NFL-{i}", date=f"{date[:10]}T00:00:00Z",
                        home_id=h_id, away_id=a_id, home_score=hs, away_score=as_))
    print(f"  NFL: {len(out)} games from 538 nfl_games.csv", flush=True)
    return out


def team_brand() -> dict:
    """Display-name map for every club seen in this build."""
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
