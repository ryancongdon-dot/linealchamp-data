"""
NHL source — hockey-reference.com season schedules.

Why HR rather than NHL API: hockey-reference has every NHL game from 1917
onward in a stable HTML table. The modern api-web.nhle.com is great for
current-season data but is patchy / nonexistent for historical seasons. The
Worker uses api-web for "today's games" (live updates) but the offline backfill
gets the whole 1917→today history from HR in one go.

URL pattern: https://www.hockey-reference.com/leagues/NHL_<YEAR>_games.html

Each page has TWO tables:
    - id="games"          — regular season
    - id="games_playoffs" — postseason

Both tables share the same columns:
    Date  Visitor  G  Home  G  ...  Att  LOG  Notes

Crawl-delay: 3 seconds (HR robots.txt).

Score notes: the H/V "G" (goals) columns are integers. If a game went to OT or
shootout, HR still records the final winning goal, so we don't need special
handling for those — the higher score wins, same as a regulation result.
"""

from __future__ import annotations

import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from lineage import Game, norm

SEED_TEAM = None  # first-game-winner; with SEED_DATE = first Stanley Cup Final Game 5
SEED_DATE = "1918-03-30"  # 1918 Stanley Cup (Toronto Arenas) — first NHL champion
# Vacancy rule remains for any future franchise stranding (rare post-1942).
VACANCY_DAYS = 365

HR_URL_TMPL = "https://www.hockey-reference.com/leagues/NHL_{year}_games.html"
CRAWL_DELAY = 3.0
HEADERS = {
    "User-Agent": "linealchamp-data/1.0 (https://linealchamp-api.ryan-congdon.workers.dev/ one-time historical backfill)"
}


def _cached_year_html(cache_dir: Path, year: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{year}.html"


def _fetch_year_html(year: int, cache_dir: Path) -> str:
    cf = _cached_year_html(cache_dir, year)
    if cf.exists() and cf.stat().st_size > 0:
        return cf.read_text(encoding="utf-8")
    r = requests.get(HR_URL_TMPL.format(year=year), headers=HEADERS, timeout=30)
    if r.status_code == 404:
        return ""
    r.raise_for_status()
    cf.write_text(r.text, encoding="utf-8")
    time.sleep(CRAWL_DELAY)
    return r.text


def _parse_table(soup: BeautifulSoup, table_id: str, year: int) -> list[Game]:
    table = soup.find("table", id=table_id)
    if not table:
        return []
    tbody = table.find("tbody")
    if not tbody:
        return []
    out: list[Game] = []
    for i, tr in enumerate(tbody.find_all("tr")):
        if tr.get("class") and "thead" in tr.get("class"):
            continue
        cells = {td.get("data-stat"): td for td in tr.find_all(["th", "td"])}
        date_td = cells.get("date_game")
        visitor_td = cells.get("visitor_team_name")
        home_td = cells.get("home_team_name")
        vg = cells.get("visitor_goals")
        hg = cells.get("home_goals")

        if not (date_td and visitor_td and home_td and vg and hg):
            continue
        v_name = visitor_td.get_text(strip=True)
        h_name = home_td.get_text(strip=True)
        v_text = vg.get_text(strip=True)
        h_text = hg.get_text(strip=True)
        if not (v_name and h_name and v_text and h_text):
            continue
        try:
            v_score = int(v_text)
            h_score = int(h_text)
        except ValueError:
            continue
        date_txt = date_td.get_text(strip=True)
        iso_date = f"{date_txt}T00:00:00Z" if len(date_txt) == 10 else f"{year}-10-01T00:00:00Z"
        out.append(
            Game(
                id=f"HR-NHL-{year}-{table_id}-{i}",
                date=iso_date,
                home_id=norm(h_name),
                away_id=norm(v_name),
                home_score=h_score,
                away_score=v_score,
            )
        )
    return out


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    y0 = int(start[:4])
    y1 = int(end[:4]) + 1  # HR uses season-end year (2024-25 season → 2025)
    out: list[Game] = []
    for y in range(y0, y1 + 1):
        try:
            html = _fetch_year_html(y, cache_dir)
            if not html:
                continue
            soup = BeautifulSoup(html, "html.parser")
            reg = _parse_table(soup, "games", y)
            post = _parse_table(soup, "games_playoffs", y)
            year_games = reg + post
            if year_games:
                out.extend(g for g in year_games if start <= g.date[:10] <= end)
                print(f"  NHL {y}: {len(reg)} reg + {len(post)} post", flush=True)
        except Exception as exc:
            print(f"  NHL {y} failed: {exc}", flush=True)
    return out
