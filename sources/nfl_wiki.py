"""
NFL historical source — Wikipedia per-team season-page scraper for 1933–2001.

Strategy (revised after the diagnostic):
    The main {YEAR}_NFL_season Wikipedia page only has division standings —
    not game schedules. But each per-team season page (e.g.
    "2001_New_England_Patriots_season") has a Schedule wikitable with the
    columns we need: Week | Date | Opponent | Result | Record | Venue | Recap.

Pipeline per season:
    1. Fetch the main {YEAR}_NFL_season page once.
    2. Discover all /wiki/{YEAR}_..._season links → that's the team list for
       the year (handles team-name changes, expansion, and league mergers
       automatically).
    3. For each unique team page:
        a. Fetch it (cached).
        b. Find every schedule-shaped wikitable (Week|Round + Date + Opponent
           + Result columns).
        c. Extract one game per data row.
        d. Tag each game with the team whose page it came from so we can
           dedupe later (each game appears on two teams' pages).
    4. Dedupe by (date, home, away) — keep the first.

Score parsing:
    Result cell is "W 14-0", "L 3-20", "T 14-14". The two numbers are
    (this-team-score, opponent-score). Opponent cell prefix "at " marks an
    away game, no prefix = home.

Preseason filter:
    Drop games whose date falls in July/August (preseason). Regular season
    starts in September, ends in late December/January. Playoffs run through
    January (sometimes February for Super Bowl, but Wikipedia per-team pages
    only include up to the conference championship a team played in).
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Iterable, Iterator, Optional

import requests
from bs4 import BeautifulSoup

from lineage import Game, norm

WIKI_URL = "https://en.wikipedia.org/wiki/{year}_NFL_season"
WIKI_UA = "linealchamp-data/1.0 (https://thelinealchamp.com; nfl-backfill)"

RATE_DELAY_SEC = 1.0  # Polite scrape pace.


# Modern abbreviations covering every NFL team Wikipedia might mention.
# Used to align Wikipedia rows with BDL's post-2002 team codes so the chain
# is continuous across the data-source boundary.
TEAM_TO_CODE: dict[str, str] = {
    # Active franchises with every historical / parenthetical name they've
    # used on Wikipedia season pages.
    "arizona cardinals": "ARI", "phoenix cardinals": "ARI",
    "st. louis cardinals": "ARI", "chicago cardinals": "ARI",
    "cardinals": "ARI",
    "atlanta falcons": "ATL", "falcons": "ATL",
    "baltimore ravens": "BAL", "ravens": "BAL",
    "buffalo bills": "BUF", "bills": "BUF",
    "carolina panthers": "CAR", "panthers": "CAR",
    "chicago bears": "CHI", "chicago staleys": "CHI",
    "decatur staleys": "CHI", "bears": "CHI",
    "cincinnati bengals": "CIN", "bengals": "CIN",
    "cleveland browns": "CLE", "browns": "CLE",
    "dallas cowboys": "DAL", "cowboys": "DAL",
    "denver broncos": "DEN", "broncos": "DEN",
    "detroit lions": "DET", "portsmouth spartans": "DET",
    "lions": "DET",
    "green bay packers": "GB", "packers": "GB",
    "houston texans": "HOU", "texans": "HOU",
    "indianapolis colts": "IND", "baltimore colts": "IND",
    "colts": "IND",
    "jacksonville jaguars": "JAX", "jaguars": "JAX",
    "kansas city chiefs": "KC", "dallas texans": "KC",
    "chiefs": "KC",
    "los angeles rams": "LAR", "st. louis rams": "LAR",
    "cleveland rams": "LAR", "rams": "LAR",
    "miami dolphins": "MIA", "dolphins": "MIA",
    "minnesota vikings": "MIN", "vikings": "MIN",
    "new england patriots": "NE", "boston patriots": "NE",
    "patriots": "NE",
    "new orleans saints": "NO", "saints": "NO",
    "new york giants": "NYG", "giants": "NYG",
    "new york jets": "NYJ", "new york titans": "NYJ",
    "jets": "NYJ",
    "las vegas raiders": "LV", "oakland raiders": "LV",
    "los angeles raiders": "LV", "raiders": "LV",
    "philadelphia eagles": "PHI", "eagles": "PHI",
    "pittsburgh steelers": "PIT", "pittsburgh pirates": "PIT",
    "steelers": "PIT",
    "los angeles chargers": "LAC", "san diego chargers": "LAC",
    "chargers": "LAC",
    "san francisco 49ers": "SF", "49ers": "SF",
    "seattle seahawks": "SEA", "seahawks": "SEA",
    "tampa bay buccaneers": "TB", "buccaneers": "TB",
    "tennessee titans": "TEN", "houston oilers": "TEN",
    "tennessee oilers": "TEN", "titans": "TEN",
    "washington commanders": "WAS",
    "washington football team": "WAS",
    "washington redskins": "WAS",
    "boston redskins": "WAS", "boston braves": "WAS",
    "commanders": "WAS", "redskins": "WAS",
}


def _team_code(name: str) -> Optional[str]:
    """Normalize a team name to its modern code."""
    if not name:
        return None
    s = name.strip().lower()
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"\(.*?\)", "", s).strip()
    # Strip leading "at " / "vs. " / "vs " (home/away markers).
    s = re.sub(r"^(?:at|vs\.?)\s+", "", s)
    s = re.sub(r"\s+", " ", s)
    if s in TEAM_TO_CODE:
        return TEAM_TO_CODE[s]
    # Try last-word fallback ("the Bears" → "bears" → CHI).
    last = s.split()[-1] if s.split() else ""
    return TEAM_TO_CODE.get(last)


# Result cell can be "W 14-0", "L 3–20", "W 14–14 (OT)", "T 14-14", etc.
RESULT_RE = re.compile(r"\b([WLT])\s*(\d+)\s*[–\-]\s*(\d+)")


def _parse_result(cell: str) -> Optional[tuple[str, int, int]]:
    """Return (this-team-result, this-team-score, opp-score) or None."""
    if not cell:
        return None
    m = RESULT_RE.search(cell)
    if not m:
        return None
    return m.group(1), int(m.group(2)), int(m.group(3))


def _parse_date(text: str, season_year: int) -> Optional[str]:
    """'September 9' → '2001-09-09' (with month-aware year inference)."""
    if not text:
        return None
    cleaned = re.sub(r"\[[^\]]*\]", "", text).strip()
    # Strip parenthetical extras like "(Thursday)".
    cleaned = re.sub(r"\(.*?\)", "", cleaned).strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%B %d", "%b %d"):
        try:
            if "%Y" in fmt:
                dt = datetime.strptime(cleaned, fmt)
            else:
                dt = datetime.strptime(cleaned, fmt).replace(year=season_year)
                # Jan/Feb belong to the *following* calendar year (playoffs).
                if dt.month in (1, 2):
                    dt = dt.replace(year=season_year + 1)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _is_schedule_table(headers: list[str]) -> bool:
    h = [c.lower() for c in headers]
    has_date = any("date" in c for c in h)
    has_opp = any("opponent" in c for c in h)
    has_result = any(c in ("result", "score") or c.startswith("result") for c in h)
    return has_date and has_opp and has_result


def _header_index(headers: list[str], *needles: str) -> Optional[int]:
    for i, h in enumerate(headers):
        hl = h.lower()
        if any(n in hl for n in needles):
            return i
    return None


def _games_from_team_page(html: str, team_code: str, season_year: int) -> list[Game]:
    """Pull every schedule-table row from one team's season page."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[Game] = []
    for table in soup.find_all("table", class_="wikitable"):
        rows = table.find_all("tr")
        if len(rows) < 2:
            continue
        headers = [c.get_text(" ", strip=True) for c in rows[0].find_all(["th", "td"])]
        if not _is_schedule_table(headers):
            continue

        date_i = _header_index(headers, "date")
        opp_i = _header_index(headers, "opponent")
        result_i = _header_index(headers, "result", "score")
        if date_i is None or opp_i is None or result_i is None:
            continue

        for row in rows[1:]:
            cells = row.find_all(["th", "td"])
            if len(cells) <= max(date_i, opp_i, result_i):
                continue
            texts = [c.get_text(" ", strip=True) for c in cells]
            iso_date = _parse_date(texts[date_i], season_year)
            if not iso_date:
                continue
            # Skip preseason — July/August games don't count toward the chain.
            month = int(iso_date[5:7])
            if month in (7, 8):
                continue
            # Skip future-scheduled but unplayed games (no result yet).
            result = _parse_result(texts[result_i])
            if not result:
                continue
            opp_text = texts[opp_i]
            opp_code = _team_code(opp_text)
            if not opp_code:
                # Logged once per season above the per-team print; useful
                # data for extending TEAM_TO_CODE if a name slips through.
                print(f"    [skip: opponent '{opp_text}' unmapped]")
                continue
            is_away = bool(re.match(r"^\s*(at|vs\.?)\s+", opp_text, re.IGNORECASE)
                          and opp_text.lower().lstrip().startswith("at "))
            _, this_score, opp_score = result
            if is_away:
                home_id, away_id = opp_code, team_code
                home_score, away_score = opp_score, this_score
            else:
                home_id, away_id = team_code, opp_code
                home_score, away_score = this_score, opp_score
            out.append(Game(
                id=f"WIKI-NFL-{season_year}-{home_id}-{away_id}-{iso_date}",
                date=f"{iso_date}T00:00:00Z",
                home_id=norm(home_id),
                away_id=norm(away_id),
                home_score=int(home_score),
                away_score=int(away_score),
            ))
    return out


def _discover_team_pages(year: int) -> list[tuple[str, str]]:
    """Returns [(team_code, page_url), ...] by scanning the season-page links."""
    r = requests.get(WIKI_URL.format(year=year),
                     headers={"User-Agent": WIKI_UA}, timeout=30)
    if r.status_code != 200:
        return []
    soup = BeautifulSoup(r.text, "html.parser")
    pat = re.compile(rf"^/wiki/{year}_(.+?)_season$")
    found: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        m = pat.match(a["href"])
        if not m:
            continue
        team_slug = m.group(1).replace("_", " ")
        code = _team_code(team_slug)
        if not code:
            continue
        # Keep the first link per team (they all point to the same page anyway).
        if code not in found:
            found[code] = "https://en.wikipedia.org" + a["href"]
    return list(found.items())


def fetch_season(year: int, cache_dir: Path) -> list[Game]:
    """Fetch and parse one NFL season's games via the per-team page strategy."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"wiki-{year}.json"
    if cache_file.exists() and cache_file.stat().st_size > 50:
        try:
            raw = json.loads(cache_file.read_text())
            return [Game(**g) for g in raw]
        except Exception:
            pass

    team_pages = _discover_team_pages(year)
    print(f"  NFL/wiki {year}: discovered {len(team_pages)} team pages")
    if not team_pages:
        return []

    raw_games: list[Game] = []
    for i, (code, url) in enumerate(team_pages, start=1):
        print(f"    [{i:>2}/{len(team_pages)}] fetching {code} ...", flush=True)
        time.sleep(RATE_DELAY_SEC)
        tr = requests.get(url, headers={"User-Agent": WIKI_UA}, timeout=30)
        if tr.status_code != 200:
            print(f"    {code}: HTTP {tr.status_code} — skipped")
            continue
        team_games = _games_from_team_page(tr.text, code, year)
        raw_games.extend(team_games)

    # Each game appears on two team pages — dedupe by (date, home, away).
    seen: set[tuple[str, str, str]] = set()
    dedup: list[Game] = []
    for g in raw_games:
        key = (g.date[:10], g.home_id, g.away_id)
        if key in seen:
            continue
        seen.add(key)
        dedup.append(g)

    cache_file.write_text(json.dumps([g.__dict__ for g in dedup]))
    print(f"  NFL/wiki {year}: parsed {len(dedup)} games "
          f"(from {len(raw_games)} per-team-page rows)")
    return dedup


def fetch_seasons(start_year: int, end_year: int, cache_dir: Path,
                  delay: float = 0.0) -> Iterator[Game]:
    for y in range(start_year, end_year + 1):
        for g in fetch_season(y, cache_dir):
            yield g
        if delay:
            time.sleep(delay)
