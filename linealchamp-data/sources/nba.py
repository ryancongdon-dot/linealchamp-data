"""
NBA source — two feeds spliced into one continuous, self-updating history.

The lineal chain must run unbroken from 1946 AND stay current after each
night's games. No single free source does both, so we splice two:

  * 1946 - 2015 Finals →  FiveThirtyEight `nbaallelo.csv` (frozen; deep history
                          that never changes, so it's cached once — see the
                          long comment in the previous version of this file).
  * 2015 Finals - today →  ESPN's public team-schedule API, one call per team
                          per season (~30 teams x ~11 seasons), fetched fresh
                          each run so the daily refresh keeps the belt current.

balldontlie's free tier rate-limits a cold full-history rebuild so severely it
never finishes (a 2.5-hour run once produced nothing), which is why neither
half of this file uses it. ESPN's site API is unauthenticated and has no
published historical CSV, so the "recent" half is a live fetch rather than a
committed file — defensively bounded (per-request timeout, retries, and a
fallback to 538-only history if ESPN is unreachable) so a bad day never
regresses the site to less data than it already has.

Franchise continuity: 538 uses franchise nicknames ("Warriors", "Lakers");
ESPN uses team abbreviations. TEAM_MAP translates ESPN's 30 modern
abbreviations to the matching 538 nickname so a franchise keeps one lineal
identity across the splice.
"""

from __future__ import annotations

import csv
import io
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from lineage import Game, norm

# Philadelphia Warriors — 1947 BAA Finals winner (the "Warriors" franchise).
SEED_TEAM = norm("Warriors")
SEED_DATE = "1947-04-22"

# Day after the 2015 Finals (538's nbaallelo.csv ends 2015-06-16).
SPLICE = "2015-06-17"

CSV_538 = "https://raw.githubusercontent.com/fivethirtyeight/data/master/nba-elo/nbaallelo.csv"
ESPN_SCHEDULE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/schedule"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}

# ESPN abbreviation -> 538 franchise nickname (all 30 teams, stable since 2015;
# no relocations to canonicalize in this window).
TEAM_MAP = {
    "ATL": "Hawks", "BOS": "Celtics", "BKN": "Nets", "CHA": "Hornets",
    "CHI": "Bulls", "CLE": "Cavaliers", "DAL": "Mavericks", "DEN": "Nuggets",
    "DET": "Pistons", "GS": "Warriors", "HOU": "Rockets", "IND": "Pacers",
    "LAC": "Clippers", "LAL": "Lakers", "MEM": "Grizzlies", "MIA": "Heat",
    "MIL": "Bucks", "MIN": "Timberwolves", "NO": "Pelicans", "NY": "Knicks",
    "OKC": "Thunder", "ORL": "Magic", "PHI": "Sixers", "PHX": "Suns",
    "POR": "Trailblazers", "SAC": "Kings", "SA": "Spurs", "TOR": "Raptors",
    "UTAH": "Jazz", "WSH": "Wizards",
}

_TEAM_NAMES: dict[str, str] = {}


def _record(nickname: str, display: str) -> str:
    code = norm(nickname)
    _TEAM_NAMES[code] = display
    return code


def _load_538(cache_dir: Path) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf = cache_dir / "nbaallelo.csv"
    if cf.exists() and cf.stat().st_size > 0:   # frozen — cache forever
        return cf.read_text(encoding="utf-8")
    r = requests.get(CSV_538, headers=HEADERS, timeout=120)
    r.raise_for_status()
    cf.write_text(r.text, encoding="utf-8")
    return r.text


def _fetch_538_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out: list[Game] = []
    for row in csv.DictReader(io.StringIO(_load_538(cache_dir))):
        if row.get("_iscopy") != "0":
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
        h_id, a_id = _record(fran, fran), _record(opp, opp)
        out.append(Game(id=(row.get("game_id") or f"NBA-{iso}-{h_id}-{a_id}"),
                        date=f"{iso}T00:00:00Z",
                        home_id=h_id, away_id=a_id, home_score=pts, away_score=opp_pts))
    return out


def _espn_season_years(start: str, end: str) -> list[int]:
    # ESPN labels an NBA season by the year it ENDS (e.g. "2015-16" -> 2016).
    y0 = max(2016, int(start[:4]) + (1 if start[5:7] >= "07" else 0))
    y1 = int(end[:4]) + 1
    return list(range(y0, y1 + 1))


# Short timeout + a circuit breaker: if ESPN is unreachable from this
# environment (blocked network, outage), each of the ~330 team/season requests
# would otherwise wait out a long timeout before failing, turning a bad network
# into a multi-hour hang. Fail fast instead: a short per-request timeout, and
# bail out entirely after a run of consecutive failures early in the loop
# (rather than grinding through the rest) so fetch_all_games's caller falls
# back to 538-only data quickly.
ESPN_TIMEOUT = 8
CIRCUIT_BREAKER_FAILURES = 8


def _fetch_espn_team_season(team: str, season: int) -> list[dict]:
    r = requests.get(
        ESPN_SCHEDULE.format(team=team.lower()),
        params={"season": season},
        headers=HEADERS, timeout=ESPN_TIMEOUT,
    )
    r.raise_for_status()
    return (r.json() or {}).get("events") or []


class _EspnUnreachable(Exception):
    pass


def _fetch_espn_games(start: str, end: str) -> list[Game]:
    out: list[Game] = []
    seen_ids: set[str] = set()
    seasons = _espn_season_years(start, end)
    failures = 0
    consecutive_failures = 0
    for team, nickname in TEAM_MAP.items():
        for season in seasons:
            try:
                events = _fetch_espn_team_season(team, season)
                consecutive_failures = 0
            except Exception:
                failures += 1
                consecutive_failures += 1
                if consecutive_failures >= CIRCUIT_BREAKER_FAILURES:
                    raise _EspnUnreachable(
                        f"{consecutive_failures} consecutive ESPN request failures — "
                        f"treating as unreachable rather than grinding through the rest"
                    )
                continue
            for ev in events:
                try:
                    comp = ev["competitions"][0]
                    status = comp.get("status", {}).get("type", {})
                    if not status.get("completed"):
                        continue
                    date = (ev.get("date") or "")[:10]
                    if not (start <= date <= end):
                        continue
                    competitors = comp["competitors"]
                    home = next(c for c in competitors if c.get("homeAway") == "home")
                    away = next(c for c in competitors if c.get("homeAway") == "away")
                    h_abbr = home["team"]["abbreviation"].upper()
                    a_abbr = away["team"]["abbreviation"].upper()
                    if h_abbr not in TEAM_MAP or a_abbr not in TEAM_MAP:
                        continue  # relocated/renamed team outside our map; skip
                    h_id = _record(TEAM_MAP[h_abbr], TEAM_MAP[h_abbr])
                    a_id = _record(TEAM_MAP[a_abbr], TEAM_MAP[a_abbr])
                    gid = str(ev.get("id") or f"ESPN-NBA-{date}-{h_id}-{a_id}")
                    if gid in seen_ids:
                        continue
                    seen_ids.add(gid)
                    out.append(Game(id=gid, date=f"{date}T00:00:00Z",
                                    home_id=h_id, away_id=a_id,
                                    home_score=int(home["score"]), away_score=int(away["score"])))
                except (KeyError, ValueError, StopIteration, TypeError):
                    continue
            time.sleep(0.15)  # light self-throttle; ESPN's site API has no published limit
    if failures:
        print(f"  NBA: {failures} ESPN team-season requests failed (network/rate-limit) — "
              f"continuing with whatever succeeded", flush=True)
    return out


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out = _fetch_538_games(start, end, cache_dir) if start[:10] < SPLICE else []
    try:
        espn = _fetch_espn_games(max(start[:10], SPLICE), end[:10])
    except Exception as exc:
        print(f"  NBA: ESPN fetch failed entirely ({exc}); using 538 history only", flush=True)
        espn = []
    out.extend(espn)
    print(f"  NBA: {len(out)} games (538 pre-2015 Finals + ESPN 2015→today, "
          f"{len(espn)} from ESPN)", flush=True)
    return out


def team_brand() -> dict:
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
