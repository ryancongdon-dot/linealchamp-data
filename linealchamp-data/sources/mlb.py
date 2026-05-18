"""
MLB source — Retrosheet game logs.

Why Retrosheet: it ships free, well-documented, fixed-width text files of every
MLB regular-season + postseason game from 1871 onward. No API, no rate limits,
no shape drift. The file format has been stable since the 1990s.

Bulk download URL pattern (https://www.retrosheet.org/gamelogs/index.html):

    https://www.retrosheet.org/gamelogs/gl<YYYY>.zip   # one zip per season
    each contains gl<YYYY>.txt — a CSV-with-quotes file (the user can rename
    them and they'll still parse).

Field positions (Retrosheet "Game Log" format, 161 columns total):
    0  date         "YYYYMMDD"
    3  visiting     team abbreviation (e.g., "NYA" for Yankees)
    6  home         team abbreviation
    9  visitor runs
    10 home runs

Reference: https://www.retrosheet.org/gamelogs/glfields.txt

Retrosheet uses Sean Lahman / Retrosheet-style team codes ("NYA" = NY Yankees AL,
"NYN" = NY Mets NL, "BOS" = Boston Red Sox, etc.) which are stable across the
entire dataset. We use these directly as team IDs — no rebrand normalization
needed since franchises that moved get a new code (e.g., "BRO" Dodgers → "LAN").

Postseason games are in the gl<YYYY>.zip too; no separate fetch.
"""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import requests

from lineage import Game, norm

SEED_TEAM = norm("PH1")  # Philadelphia Athletics, 1871 NA Champions
SEED_DATE = "1871-05-04"

GAMELOG_URL_TMPL = "https://www.retrosheet.org/gamelogs/gl{year}.zip"
HEADERS = {"User-Agent": "linealchamp/1.0 (one-time historical backfill)"}


def _download_year(year: int, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / f"gl{year}.zip"
    if zip_path.exists() and zip_path.stat().st_size > 0:
        return zip_path
    r = requests.get(GAMELOG_URL_TMPL.format(year=year), headers=HEADERS, timeout=60)
    if r.status_code == 404:
        return zip_path  # mark missing; caller will skip
    r.raise_for_status()
    zip_path.write_bytes(r.content)
    return zip_path


def _parse_year(zip_path: Path, year: int) -> list[Game]:
    if not zip_path.exists() or zip_path.stat().st_size == 0:
        return []
    out: list[Game] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.endswith(".txt") or n.endswith(".TXT")]
        if not names:
            return []
        with zf.open(names[0]) as f:
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
                            id=f"RS-{year}-{i}",
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


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = int(start[:4])
    y1 = int(end[:4])
    out: list[Game] = []
    for y in range(y0, y1 + 1):
        try:
            zp = _download_year(y, cache_dir)
            year_games = _parse_year(zp, y)
            if year_games:
                out.extend(g for g in year_games if start <= g.date[:10] <= end)
                print(f"  MLB {y}: {len(year_games)} games", flush=True)
            else:
                print(f"  MLB {y}: empty (file missing or invalid)", flush=True)
        except Exception as exc:
            print(f"  MLB {y} failed: {exc}", flush=True)
    return out
