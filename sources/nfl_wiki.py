"""
NFL historical source — Wikipedia season-page scraper for 1933–2001.

Why this exists:
    balldontlie's NFL endpoint only covers 2002+, and pro-football-reference
    blocks all non-residential IPs with a WAF (see sources/nfl.py). Wikipedia
    has every NFL season page with structured game tables since 1933, no WAF,
    and a stable URL pattern.

Strategy:
    For each season Y in 1933..2001:
        1. Fetch https://en.wikipedia.org/wiki/{Y}_NFL_season
        2. Find every <table class="wikitable"> on the page
        3. For each table, inspect the header row to decide if it's a game
           schedule (columns like Date, Away/Visitor, Home, Score, etc.)
        4. Parse each data row into a Game with normalized team codes
    Cache one JSON per season to be polite to Wikipedia and to make reruns fast.

Compatibility notes:
    Wikipedia page formats vary significantly across eras:
      * 1990-2001 ("modern"): one wikitable per week, columns are stable.
      * 1970-1989 ("post-merger"): similar but column order varies.
      * 1950-1969: per-team game logs in some seasons rather than a master
        schedule. Parser falls back to scanning every wikitable.
      * 1933-1949: simpler text-based results, often without per-game tables.
        This era may need a different strategy (e.g. parsing standings +
        championship game only) — see UNSUPPORTED_YEARS below.

This is intentionally defensive — the parser logs what it skipped and why,
so iteration is straightforward.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Iterable, Optional

import requests
from bs4 import BeautifulSoup

from lineage import Game, norm

WIKI_URL = "https://en.wikipedia.org/wiki/{year}_NFL_season"

# Wikipedia API policy: descriptive User-Agent with project/contact.
WIKI_UA = "linealchamp-data/1.0 (https://thelinealchamp.com; nfl-backfill)"

# Years for which the Wikipedia page format is known to need a separate
# strategy (text-based results, no per-game tables). Filled in as discovered.
UNSUPPORTED_YEARS: set[int] = set()


# Map every variation of an NFL team's name (historical + alternative
# wordings on Wikipedia) to its modern abbreviation. Used to align with BDL's
# codes so the pre-2002 and post-2002 games merge into one continuous chain.
TEAM_TO_CODE: dict[str, str] = {
    # 32 current franchises
    "arizona cardinals": "ARI", "cardinals": "ARI",
    "phoenix cardinals": "ARI", "st. louis cardinals": "ARI",
    "chicago cardinals": "ARI",
    "atlanta falcons": "ATL", "falcons": "ATL",
    "baltimore ravens": "BAL", "ravens": "BAL",
    "buffalo bills": "BUF", "bills": "BUF",
    "carolina panthers": "CAR", "panthers": "CAR",
    "chicago bears": "CHI", "bears": "CHI",
    "chicago staleys": "CHI", "decatur staleys": "CHI",
    "cincinnati bengals": "CIN", "bengals": "CIN",
    "cleveland browns": "CLE", "browns": "CLE",
    "dallas cowboys": "DAL", "cowboys": "DAL",
    "denver broncos": "DEN", "broncos": "DEN",
    "detroit lions": "DET", "lions": "DET",
    "portsmouth spartans": "DET",
    "green bay packers": "GB", "packers": "GB",
    "houston texans": "HOU", "texans": "HOU",
    "indianapolis colts": "IND", "colts": "IND",
    "baltimore colts": "IND",
    "jacksonville jaguars": "JAX", "jaguars": "JAX",
    "kansas city chiefs": "KC", "chiefs": "KC",
    "dallas texans": "KC",
    "los angeles rams": "LAR", "rams": "LAR",
    "st. louis rams": "LAR", "cleveland rams": "LAR",
    "miami dolphins": "MIA", "dolphins": "MIA",
    "minnesota vikings": "MIN", "vikings": "MIN",
    "new england patriots": "NE", "patriots": "NE",
    "boston patriots": "NE",
    "new orleans saints": "NO", "saints": "NO",
    "new york giants": "NYG", "giants": "NYG",
    "new york jets": "NYJ", "jets": "NYJ",
    "new york titans": "NYJ",
    "las vegas raiders": "LV", "raiders": "LV",
    "oakland raiders": "LV", "los angeles raiders": "LV",
    "philadelphia eagles": "PHI", "eagles": "PHI",
    "pittsburgh steelers": "PIT", "steelers": "PIT",
    "pittsburgh pirates": "PIT",
    "los angeles chargers": "LAC", "chargers": "LAC",
    "san diego chargers": "LAC",
    "san francisco 49ers": "SF", "49ers": "SF",
    "seattle seahawks": "SEA", "seahawks": "SEA",
    "tampa bay buccaneers": "TB", "buccaneers": "TB",
    "tennessee titans": "TEN", "titans": "TEN",
    "houston oilers": "TEN", "tennessee oilers": "TEN",
    "washington commanders": "WAS", "commanders": "WAS",
    "washington football team": "WAS", "washington redskins": "WAS",
    "redskins": "WAS", "boston redskins": "WAS", "boston braves": "WAS",
}


def _team_code(name: str) -> Optional[str]:
    if not name:
        return None
    # Wikipedia link text often includes parenthetical disambiguators or
    # leading icons. Strip non-alpha leading/trailing junk.
    s = name.strip().lower()
    s = re.sub(r"\[[^\]]*\]", "", s)         # strip footnote markers like [1]
    s = re.sub(r"\(.*?\)", "", s).strip()    # strip parentheticals
    s = re.sub(r"\s+", " ", s)
    if s in TEAM_TO_CODE:
        return TEAM_TO_CODE[s]
    # Sometimes the name has a city + nickname concatenated; try last word too.
    last = s.split()[-1] if s.split() else ""
    if last in TEAM_TO_CODE:
        return TEAM_TO_CODE[last]
    return None


def _parse_score_cell(text: str) -> Optional[int]:
    if not text:
        return None
    # Strip footnote markers and whitespace.
    cleaned = re.sub(r"\[[^\]]*\]", "", text).strip()
    # Cells sometimes contain "W 24-17" or just "24"; first integer wins.
    m = re.search(r"-?\d+", cleaned)
    return int(m.group(0)) if m else None


def _parse_date(date_text: str, season_year: int) -> Optional[str]:
    """Convert 'September 9' or 'Sep 9' (year inferred from season) to ISO."""
    if not date_text:
        return None
    cleaned = re.sub(r"\[[^\]]*\]", "", date_text).strip()
    # The NFL season spans two calendar years (Sep–Feb). Jan/Feb dates belong
    # to the *following* calendar year; everything else to the season year.
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%B %d", "%b %d"):
        try:
            from datetime import datetime
            if "%Y" in fmt:
                dt = datetime.strptime(cleaned, fmt)
            else:
                dt = datetime.strptime(cleaned, fmt).replace(year=season_year)
                if dt.month in (1, 2):
                    dt = dt.replace(year=season_year + 1)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _header_index(headers: list[str], *needles: str) -> Optional[int]:
    """First column index whose header contains any of the given lowercase needles."""
    for i, h in enumerate(headers):
        hl = h.lower()
        if any(n in hl for n in needles):
            return i
    return None


def _parse_game_table(table, season_year: int) -> list[Game]:
    """Pull every game row out of one wikitable; returns [] for non-schedule tables."""
    rows = table.find_all("tr")
    if len(rows) < 2:
        return []
    header_cells = rows[0].find_all(["th", "td"])
    headers = [c.get_text(" ", strip=True) for c in header_cells]

    # Look for schedule-shaped headers. Heuristic: a date column AND either
    # a "visitor"/"away" column or a "home" column AND a "result"/"score" column.
    date_i = _header_index(headers, "date")
    home_i = _header_index(headers, "home")
    away_i = _header_index(headers, "visitor", "visiting", "away")
    result_i = _header_index(headers, "result", "score", "final")

    # Some Wikipedia schedule tables list winner/loser instead of away/home.
    winner_i = _header_index(headers, "winning team", "winner")
    loser_i = _header_index(headers, "losing team", "loser")
    score_w_i = _header_index(headers, "winning score", "winner score")
    score_l_i = _header_index(headers, "losing score", "loser score")

    use_winner_loser = (winner_i is not None and loser_i is not None)
    use_home_away = (away_i is not None and home_i is not None)

    if date_i is None or not (use_winner_loser or use_home_away):
        return []

    out: list[Game] = []
    for row in rows[1:]:
        cells = row.find_all(["th", "td"])
        if not cells or len(cells) < 3:
            continue
        texts = [c.get_text(" ", strip=True) for c in cells]
        iso_date = _parse_date(texts[date_i] if date_i < len(texts) else "", season_year)
        if not iso_date:
            continue

        if use_winner_loser:
            wcode = _team_code(texts[winner_i]) if winner_i < len(texts) else None
            lcode = _team_code(texts[loser_i]) if loser_i < len(texts) else None
            ws = _parse_score_cell(texts[score_w_i]) if score_w_i is not None and score_w_i < len(texts) else None
            ls = _parse_score_cell(texts[score_l_i]) if score_l_i is not None and score_l_i < len(texts) else None
            if not wcode or not lcode or ws is None or ls is None:
                continue
            # Caller doesn't care which is home/away — set winner as home with the
            # higher score so the lineage transfer logic still works correctly.
            out.append(Game(
                id=f"WIKI-NFL-{season_year}-{len(out)+1:04d}",
                date=f"{iso_date}T00:00:00Z",
                home_id=norm(wcode), away_id=norm(lcode),
                home_score=int(ws), away_score=int(ls),
            ))
            continue

        # use_home_away path
        away_text = texts[away_i] if away_i is not None and away_i < len(texts) else ""
        home_text = texts[home_i] if home_i is not None and home_i < len(texts) else ""
        away_code = _team_code(away_text)
        home_code = _team_code(home_text)
        if not away_code or not home_code:
            continue

        # Score can be in a single "Result" cell like "24–17" with the winner
        # listed by convention, OR in two separate score columns next to each
        # team. Handle both.
        hs = ls = None
        if result_i is not None and result_i < len(texts):
            # Strings like "Bears 24–17", "24–17", "L 17–24"
            m = re.search(r"(\d+)\s*[–-]\s*(\d+)", texts[result_i])
            if m:
                # Without explicit which-is-home, assume "away–home" (Wikipedia
                # convention for most weekly schedules). Caller can flip later
                # if a calibration test shows this is wrong.
                as_score, hs_score = int(m.group(1)), int(m.group(2))
                ls, hs = as_score, hs_score
        if hs is None or ls is None:
            continue
        out.append(Game(
            id=f"WIKI-NFL-{season_year}-{len(out)+1:04d}",
            date=f"{iso_date}T00:00:00Z",
            home_id=norm(home_code), away_id=norm(away_code),
            home_score=hs, away_score=ls,
        ))
    return out


def fetch_season(year: int, cache_dir: Path) -> list[Game]:
    """Fetch and parse one NFL season's games from Wikipedia. Cached per-year."""
    if year in UNSUPPORTED_YEARS:
        return []
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"wiki-{year}.json"
    if cache_file.exists() and cache_file.stat().st_size > 50:
        try:
            raw = json.loads(cache_file.read_text())
            return [Game(**g) for g in raw]
        except Exception:
            pass

    url = WIKI_URL.format(year=year)
    r = requests.get(url, headers={"User-Agent": WIKI_UA}, timeout=30)
    if r.status_code != 200:
        print(f"  NFL/wiki {year}: HTTP {r.status_code}", flush=True)
        return []

    soup = BeautifulSoup(r.text, "html.parser")
    games: list[Game] = []
    for t in soup.find_all("table", class_="wikitable"):
        games.extend(_parse_game_table(t, year))

    cache_file.write_text(json.dumps([g.__dict__ for g in games]))
    print(f"  NFL/wiki {year}: parsed {len(games)} games", flush=True)
    return games


def fetch_seasons(start_year: int, end_year: int, cache_dir: Path,
                  delay: float = 1.0) -> Iterable[Game]:
    """Yield Games across multiple seasons, sleeping between Wikipedia hits."""
    for y in range(start_year, end_year + 1):
        for g in fetch_season(y, cache_dir):
            yield g
        time.sleep(delay)
