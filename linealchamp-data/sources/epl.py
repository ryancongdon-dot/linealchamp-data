"""
EPL source — football-data.co.uk CSV archives.

Why not balldontlie: its EPL endpoint rate-limits so aggressively (HTTP 429
even after a 60-second backoff) that a single uncached season could not be
fetched inside a 60-minute CI budget — EPL timed out run after run. It is a
dead end for this data.

football-data.co.uk publishes every Premier League result as a free,
unthrottled CSV, one file per season, so a full 1992->present rebuild takes
seconds and never hits a rate limit.

URL: https://www.football-data.co.uk/mmz4281/{code}/E0.csv
  code = two 2-digit years: "9293" = 1992-93 season ... "2526" = 2025-26.
  E0 = the Premier League (top flight).

Columns used (football-data's format is stable and documented):
  Date      DD/MM/YY (older seasons) or DD/MM/YYYY (newer)
  HomeTeam  spaced club name, e.g. "Man United", "Nott'm Forest"
  AwayTeam  "
  FTHG      full-time home goals
  FTAG      full-time away goals

Team identity: we use football-data's spaced club names directly (via norm()).
They're stable within the dataset and human-readable, so the source also hands
back a display-name map (team_brand()) that build_lineage.py ships to the
Worker — no ugly ALL-CAPS codes on the site.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm
from sources.util import cache_is_complete

# Leeds United won the last pre-Premier-League top-flight title (1991-92);
# football-data calls them "Leeds". They seed the lineage.
SEED_TEAM = norm("Leeds")
SEED_DATE = "1992-08-15"

URL_TMPL = "https://www.football-data.co.uk/mmz4281/{code}/E0.csv"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}

# Populated during parsing: norm(name) -> original spaced name, for display.
_TEAM_NAMES: dict[str, str] = {}


def _season_code(year: int) -> str:
    """1992 -> '9293', 2025 -> '2526'."""
    return f"{year % 100:02d}{(year + 1) % 100:02d}"


def _parse_date(s: str) -> Optional[str]:
    s = (s or "").strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%dT00:00:00Z")
        except ValueError:
            continue
    return None


def _cache_path(cache_dir: Path, year: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"E0-{year}.csv"


def _fetch_season_csv(year: int, cache_dir: Path) -> str:
    cf = _cache_path(cache_dir, year)
    # A season labeled N runs Aug N -> May N+1; only trust the cache once it's over.
    if cache_is_complete(cf, f"{year + 1}-06-15"):
        return cf.read_text(encoding="latin-1")
    r = requests.get(URL_TMPL.format(code=_season_code(year)), headers=HEADERS, timeout=60)
    if r.status_code == 404:
        return ""
    r.raise_for_status()
    text = r.content.decode("latin-1")
    cf.write_text(text, encoding="latin-1")
    return text


def _parse_csv(text: str, year: int) -> list[Game]:
    if not text.strip():
        return []
    out: list[Game] = []
    reader = csv.DictReader(io.StringIO(text))
    for i, row in enumerate(reader):
        home = (row.get("HomeTeam") or "").strip()
        away = (row.get("AwayTeam") or "").strip()
        hg = (row.get("FTHG") or "").strip()
        ag = (row.get("FTAG") or "").strip()
        if not home or not away or hg == "" or ag == "":
            continue
        iso = _parse_date(row.get("Date"))
        if iso is None:
            continue
        try:
            hs, as_ = int(hg), int(ag)
        except ValueError:
            continue
        h_id, a_id = norm(home), norm(away)
        _TEAM_NAMES[h_id] = home
        _TEAM_NAMES[a_id] = away
        out.append(
            Game(id=f"FD-EPL-{year}-{i}", date=iso,
                 home_id=h_id, away_id=a_id, home_score=hs, away_score=as_)
        )
    return out


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = max(1992, int(start[:4]))
    y1 = int(end[:4])
    out: list[Game] = []
    for year in range(y0, y1 + 1):
        try:
            text = _fetch_season_csv(year, cache_dir)
        except Exception as exc:
            print(f"  EPL {year} fetch failed: {exc}", flush=True)
            continue
        games = [g for g in _parse_csv(text, year) if start <= g.date[:10] <= end]
        out.extend(games)
        print(f"  EPL {year}: {len(games)} games", flush=True)
    return out


def team_brand() -> dict:
    """Display-name map for every club seen in this build, so the site shows
    'Man United' rather than 'MANUNITED'. Consumed by build_lineage.py."""
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
