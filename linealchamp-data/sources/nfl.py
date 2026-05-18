"""
NFL source — pro-football-reference.com season schedules.

Why scraping PFR rather than nflverse or BDL:
- balldontlie NFL only covers 2002+, missing 82 years of lineage.
- nflverse covers 1999+ — better than BDL but still misses pre-1999.
- PFR has every game from 1920 onward in a consistent table.

URL pattern: https://www.pro-football-reference.com/years/<YEAR>/games.htm

Each page has a "games" table with columns:
    Week  Day  Date  Time  Winner/Tie  At  Loser/Tie  Boxscore  PtsW  PtsL  YdsW  TOW  YdsL  TOL

Critical parser quirks:
- "At" column contains '@' if the row's "Loser" was the home team. Otherwise
  the "Winner" was the home team.
- Pre-season weeks ("Pre0"..."Pre4") and the All-Star game must be filtered.
  We only want regular-season (numeric weeks) and postseason ("WildCard",
  "Division", "ConfChamp", "SuperBowl", "WC", "Div").
- Some early-1920s rows have no scores ("PtsW", "PtsL" blank) — skip them.
- The 2020 season had unusual "WildCard" labels because of the expanded format.

PFR's robots.txt asks for a 3-second crawl-delay. We honor that.

Team-name normalization: PFR uses full team names ("New England Patriots",
"Boston Yanks", etc.). We rely on the lineage.norm() (uppercase + no whitespace)
which means "NEWENGLANDPATRIOTS" stays as one ID across the whole dataset.
Franchise relocations get a new ID (e.g., "STLOUISRAMS" → "LOSANGELESRAMS")
which is the correct behavior for lineal lineage — the city move counts as a
new entity for tracking purposes. If you want to merge them, do it in the
Worker's brand mapping, not here.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from lineage import Game, norm

SEED_TEAM = norm("Akron Pros")  # 1920 APFA inaugural champion (conventional NFL lineal seed)
SEED_DATE = "1920-09-26"  # first APFA game date

PFR_URL_TMPL = "https://www.pro-football-reference.com/years/{year}/games.htm"
CRAWL_DELAY = 3.0
HEADERS = {
    "User-Agent": "linealchamp-data/1.0 (https://linealchamp-api.ryan-congdon.workers.dev/ one-time historical backfill)"
}

VALID_WEEK_RE = re.compile(
    r"^(\d+|WildCard|WC|Division|Div|ConfChamp|Conf|SuperBowl|SB)$",
    re.IGNORECASE,
)


def _cached_year_html(cache_dir: Path, year: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{year}.html"


def _fetch_year_html(year: int, cache_dir: Path) -> str:
    cf = _cached_year_html(cache_dir, year)
    if cf.exists() and cf.stat().st_size > 0:
        return cf.read_text(encoding="utf-8")
    r = requests.get(PFR_URL_TMPL.format(year=year), headers=HEADERS, timeout=30)
    if r.status_code == 404:
        return ""
    r.raise_for_status()
    cf.write_text(r.text, encoding="utf-8")
    time.sleep(CRAWL_DELAY)
    return r.text


def _parse_games_table(html: str, year: int) -> list[Game]:
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="games") or soup.find("table", {"class": "stats_table"})
    if not table:
        return []
    out: list[Game] = []
    tbody = table.find("tbody")
    if not tbody:
        return []
    for i, tr in enumerate(tbody.find_all("tr")):
        if tr.get("class") and "thead" in tr.get("class"):
            continue
        # Cells: PFR uses data-stat attributes which are stable across years.
        cells = {td.get("data-stat"): td for td in tr.find_all(["th", "td"])}
        week = (cells.get("week_num") or cells.get("week"))
        if week is None:
            continue
        week_txt = week.get_text(strip=True)
        if not VALID_WEEK_RE.match(week_txt):
            continue

        date_td = cells.get("game_date") or cells.get("boxscore_word")
        winner_td = cells.get("winner")
        at_td = cells.get("game_location") or cells.get("game_outcome")
        loser_td = cells.get("loser")
        ptsw_td = cells.get("pts_win")
        ptsl_td = cells.get("pts_lose")
        boxscore_td = cells.get("boxscore_word")

        if not (winner_td and loser_td and ptsw_td and ptsl_td):
            continue

        winner_name = winner_td.get_text(strip=True)
        loser_name = loser_td.get_text(strip=True)
        if not winner_name or not loser_name:
            continue

        try:
            pw = int(ptsw_td.get_text(strip=True))
            pl = int(ptsl_td.get_text(strip=True))
        except ValueError:
            continue  # game not yet played, or pts blank

        # Determine home/away. The 'at' cell contains '@' when the WINNER was on
        # the road (i.e., LOSER was at home).
        at_txt = at_td.get_text(strip=True) if at_td else ""
        winner_was_away = at_txt == "@"
        if winner_was_away:
            home_id, home_score = norm(loser_name), pl
            away_id, away_score = norm(winner_name), pw
        else:
            home_id, home_score = norm(winner_name), pw
            away_id, away_score = norm(loser_name), pl

        date_txt = date_td.get_text(strip=True) if date_td else f"{year}-09-01"
        # PFR date is "2023-09-07" format; sometimes "Sep 7" for current week
        # — fall back to year-01-01 in that case so chronology stays sane.
        try:
            from datetime import datetime as _dt
            d = _dt.strptime(date_txt, "%Y-%m-%d")
            iso_date = d.strftime("%Y-%m-%dT00:00:00Z")
        except ValueError:
            iso_date = f"{year}-09-01T00:00:00Z"

        # Game ID from boxscore link if available, else a synthetic one.
        bs_link = boxscore_td.find("a") if boxscore_td else None
        gid = (
            bs_link.get("href").split("/")[-1].replace(".htm", "")
            if bs_link
            else f"PFR-{year}-{i}"
        )

        out.append(
            Game(
                id=gid,
                date=iso_date,
                home_id=home_id,
                away_id=away_id,
                home_score=home_score,
                away_score=away_score,
            )
        )
    return out


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = int(start[:4])
    y1 = int(end[:4])
    out: list[Game] = []
    for y in range(y0, y1 + 1):
        try:
            html = _fetch_year_html(y, cache_dir)
            year_games = _parse_games_table(html, y)
            if year_games:
                out.extend(g for g in year_games if start <= g.date[:10] <= end)
                print(f"  NFL {y}: {len(year_games)} games", flush=True)
        except Exception as exc:
            print(f"  NFL {y} failed: {exc}", flush=True)
    return out
