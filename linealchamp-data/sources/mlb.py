"""
MLB source — Retrosheet game logs (pre-2012) + MLB StatsAPI (2012 onward).

Why two sources:

- Retrosheet ships free, stable, fixed-width text files of every MLB
  regular-season game from 1871 onward — perfect for deep history. BUT its
  yearly gl<YYYY>.zip files contain ONLY the regular season (the postseason
  lives in separate bundle files), and the current season's file doesn't
  exist until months after the season ends. Both of those bit us: the live
  site's MLB belt was stuck at the last day of the regular season, with the
  entire playoffs — and the entire current season — missing.

- MLB's official StatsAPI (statsapi.mlb.com) is free, needs no key, includes
  the postseason, and is updated live. We use it for every season from
  STATSAPI_FROM_YEAR on, which also covers the in-progress season.

The boundary is 2012 because every current franchise's Retrosheet-style team
code has been stable since then (the Marlins switched FLO→MIA in 2012), so
the StatsAPI id→code mapping below can be constant without breaking lineage
continuity across the boundary.

Retrosheet postseason bundles (all years in one file each):
    https://www.retrosheet.org/gamelogs/glws.zip   World Series (1903+)
    https://www.retrosheet.org/gamelogs/gllc.zip   LCS (1969+)
    https://www.retrosheet.org/gamelogs/gldv.zip   Division Series (1995+)
    https://www.retrosheet.org/gamelogs/glwc.zip   Wild Card (2012+)

Game Log field positions (161 columns; https://www.retrosheet.org/gamelogs/glfields.txt):
    0  date "YYYYMMDD"    3 visiting team    6 home team
    9  visitor runs      10 home runs
"""

from __future__ import annotations

import calendar
import csv
import io
import json
import zipfile
from pathlib import Path

import requests

from lineage import Game, norm
from sources.util import cache_is_complete

SEED_TEAM = norm("PH1")  # Philadelphia Athletics, 1871 NA Champions
SEED_DATE = "1871-05-04"

GAMELOG_URL_TMPL = "https://www.retrosheet.org/gamelogs/gl{year}.zip"
POSTSEASON_BUNDLES = ("glws", "gllc", "gldv", "glwc")
POSTSEASON_URL_TMPL = "https://www.retrosheet.org/gamelogs/{name}.zip"
HEADERS = {"User-Agent": "linealchamp/1.0 (historical backfill)"}

STATSAPI_FROM_YEAR = 2012
STATSAPI_URL = "https://statsapi.mlb.com/api/v1/schedule"
# R regular, F wild card, D division series, L LCS, W World Series,
# P/C legacy playoff types. Excludes spring training, exhibitions, All-Star.
STATSAPI_GAME_TYPES = {"R", "F", "D", "L", "W", "P", "C"}

# MLB StatsAPI team id → Retrosheet team code, so lineage IDs stay
# consistent across the Retrosheet/StatsAPI boundary.
STATSAPI_TEAM_TO_RS = {
    108: "ANA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHN",
    113: "CIN", 114: "CLE", 115: "COL", 116: "DET", 117: "HOU",
    118: "KCA", 119: "LAN", 120: "WAS", 121: "NYN", 133: "OAK",
    134: "PIT", 135: "SDN", 136: "SEA", 137: "SFN", 138: "SLN",
    139: "TBA", 140: "TEX", 141: "TOR", 142: "MIN", 143: "PHI",
    144: "ATL", 145: "CHA", 146: "MIA", 147: "NYA", 158: "MIL",
}


# ---------------------------------------------------------------- Retrosheet

def _download_zip(url: str, zip_path: Path) -> Path:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists() and zip_path.stat().st_size > 0:
        return zip_path
    r = requests.get(url, headers=HEADERS, timeout=60)
    if r.status_code == 404:
        return zip_path  # mark missing; caller will skip
    r.raise_for_status()
    zip_path.write_bytes(r.content)
    return zip_path


def _parse_gamelog(zip_path: Path, tag: str) -> list[Game]:
    if not zip_path.exists() or zip_path.stat().st_size == 0:
        return []
    out: list[Game] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".txt")]
        for name in names:
            with zf.open(name) as f:
                text = io.TextIOWrapper(f, encoding="latin-1", newline="")
                reader = csv.reader(text)
                for i, row in enumerate(reader):
                    if len(row) < 11:
                        continue
                    try:
                        date_str = row[0]  # "YYYYMMDD"
                        visitor = row[3]
                        home = row[6]
                        vis_runs = row[9]
                        home_runs = row[10]
                        if not date_str or not visitor or not home:
                            continue
                        if not vis_runs or not home_runs:
                            continue
                        iso_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T00:00:00Z"
                        out.append(
                            Game(
                                id=f"RS-{tag}-{name}-{i}",
                                date=iso_date,
                                home_id=norm(home),
                                away_id=norm(visitor),
                                home_score=int(home_runs),
                                away_score=int(vis_runs),
                            )
                        )
                    except (ValueError, IndexError):
                        continue
    return out


def _retrosheet_year(year: int, cache_dir: Path) -> list[Game]:
    zp = _download_zip(GAMELOG_URL_TMPL.format(year=year), cache_dir / f"gl{year}.zip")
    return _parse_gamelog(zp, str(year))


def _retrosheet_postseason(cache_dir: Path) -> list[Game]:
    """All postseason games from the Retrosheet bundle files (all years)."""
    out: list[Game] = []
    for name in POSTSEASON_BUNDLES:
        try:
            zp = _download_zip(POSTSEASON_URL_TMPL.format(name=name), cache_dir / f"{name}.zip")
            games = _parse_gamelog(zp, name.upper())
            if games:
                print(f"  MLB postseason bundle {name}: {len(games)} games", flush=True)
            out.extend(games)
        except Exception as exc:
            print(f"  MLB postseason bundle {name} failed: {exc}", flush=True)
    return out


# ------------------------------------------------------------- MLB StatsAPI

def _statsapi_month(year: int, month: int, cache_dir: Path) -> list[dict]:
    last_day = calendar.monthrange(year, month)[1]
    m_start = f"{year}-{month:02d}-01"
    m_end = f"{year}-{month:02d}-{last_day:02d}"
    cf = cache_dir / f"statsapi-{year}-{month:02d}.json"
    if cache_is_complete(cf, m_end):
        try:
            return json.loads(cf.read_text())
        except Exception:
            pass
    r = requests.get(
        STATSAPI_URL,
        params={"sportId": "1", "startDate": m_start, "endDate": m_end},
        headers=HEADERS,
        timeout=60,
    )
    r.raise_for_status()
    dates = (r.json() or {}).get("dates", [])
    games = [g for d in dates for g in d.get("games", [])]
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(games))
    return games


def _statsapi_team_id(side: dict) -> str:
    team = side.get("team") or {}
    code = STATSAPI_TEAM_TO_RS.get(team.get("id"))
    if code:
        return norm(code)
    # Unknown franchise (future expansion?) — fall back to the name so the
    # game isn't lost, and say so loudly.
    name = team.get("name") or "UNKNOWN"
    print(f"  MLB: no Retrosheet code for StatsAPI team {team.get('id')} ({name})", flush=True)
    return norm(name)


def _statsapi_year(year: int, cache_dir: Path) -> list[Game]:
    out: list[Game] = []
    for month in range(3, 12):  # late March openers through early November WS
        try:
            items = _statsapi_month(year, month, cache_dir)
        except Exception as exc:
            print(f"  MLB statsapi {year}-{month:02d} failed: {exc}", flush=True)
            continue
        for g in items:
            if g.get("gameType") not in STATSAPI_GAME_TYPES:
                continue
            status = g.get("status") or {}
            if status.get("abstractGameState") != "Final":
                continue
            detailed = str(status.get("detailedState") or "")
            if any(b in detailed for b in ("Postponed", "Cancelled", "Suspended")):
                continue
            teams = g.get("teams") or {}
            home, away = teams.get("home") or {}, teams.get("away") or {}
            hs, as_ = home.get("score"), away.get("score")
            if hs is None or as_ is None:
                continue
            date = g.get("officialDate") or str(g.get("gameDate") or "")[:10]
            if not date:
                continue
            # Encode doubleheader game number in the seconds so same-day
            # games sort in the order they were played.
            try:
                game_no = max(1, min(int(g.get("gameNumber") or 1), 9))
            except (TypeError, ValueError):
                game_no = 1
            out.append(
                Game(
                    id=f"MLBAM-{g.get('gamePk')}",
                    date=f"{date}T00:00:0{game_no - 1}Z",
                    home_id=_statsapi_team_id(home),
                    away_id=_statsapi_team_id(away),
                    home_score=int(hs),
                    away_score=int(as_),
                )
            )
    return out


# ------------------------------------------------------------------- driver

def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = int(start[:4])
    y1 = int(end[:4])
    out: list[Game] = []

    # Deep history from Retrosheet (regular season files are per-year;
    # postseason comes from the all-years bundle files).
    if y0 < STATSAPI_FROM_YEAR:
        for y in range(y0, min(y1, STATSAPI_FROM_YEAR - 1) + 1):
            try:
                year_games = _retrosheet_year(y, cache_dir)
                if year_games:
                    out.extend(g for g in year_games if start <= g.date[:10] <= end)
                    print(f"  MLB {y}: {len(year_games)} games", flush=True)
                else:
                    print(f"  MLB {y}: empty (file missing or invalid)", flush=True)
            except Exception as exc:
                print(f"  MLB {y} failed: {exc}", flush=True)

        for g in _retrosheet_postseason(cache_dir):
            if int(g.date[:4]) < STATSAPI_FROM_YEAR and start <= g.date[:10] <= end:
                out.append(g)

    # Recent seasons (incl. in-progress) from MLB StatsAPI.
    for y in range(max(y0, STATSAPI_FROM_YEAR), y1 + 1):
        year_games = _statsapi_year(y, cache_dir)
        out.extend(g for g in year_games if start <= g.date[:10] <= end)
        print(f"  MLB {y} (statsapi): {len(year_games)} games", flush=True)

    return out
