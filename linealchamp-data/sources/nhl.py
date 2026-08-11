"""
NHL source — ESPN's public team-schedule API, live and self-updating.

hockey-reference.com (the previous source) now returns HTTP 403 to automated
requests, and unlike NFL/NBA, no frozen historical CSV exists for NHL (538
never published one; the NHL's own deep-history statsapi was retired in 2024).

Rather than ship a fragile 2000-2021 relocation map I can't verify from this
environment (Atlanta -> Winnipeg, Phoenix -> Arizona -> Utah, etc. all inside
that window), this source deliberately starts the chain at the **2021-22
season** — the point the league settled at its current 32-team footprint
(Seattle's expansion) — and lets it grow forward from there. It's a real,
current, self-updating lineal chain; it just doesn't reach back to 1917 yet.
Extending it backward is a separate, deliberate addition once a reliable bulk
source for 1917-2021 is available (e.g. a committed CSV).

Team continuity: ESPN's `competitor.team.displayName` is read directly from
each response rather than a hand-maintained name map, so a rebrand (e.g.
Arizona Coyotes -> Utah Hockey Club, 2024) doesn't require a code change here
— only the abbreviation-to-canonical-code map below needs one entry when a
franchise's ESPN abbreviation itself changes.
"""

from __future__ import annotations

import time
from pathlib import Path

import requests

from lineage import Game, norm

# No historical base to seed from — the chain seeds itself from the first
# game in the fetch window (compute_lineage treats None as "auto-seed from
# the first game's winner").
SEED_TEAM = None
SEED_DATE = "2021-10-01"  # 2021-22 season start (informational only)

ESPN_SCHEDULE = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/{team}/schedule"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}

# ESPN abbreviation -> canonical code. Only needed when a franchise's ESPN
# abbreviation itself changed (Arizona Coyotes -> Utah, 2024); everything else
# maps to itself.
CANON = {"ARI": "UTAH"}

# The 32 current ESPN NHL team abbreviations (stable since the 2021 Seattle
# expansion); UTAH covers the Arizona-era abbreviation via CANON above.
TEAMS = [
    "ANA", "ARI", "BOS", "BUF", "CGY", "CAR", "CHI", "COL", "CBJ", "DAL",
    "DET", "EDM", "FLA", "LA", "MIN", "MTL", "NSH", "NJ", "NYI", "NYR",
    "OTT", "PHI", "PIT", "SJ", "SEA", "STL", "TB", "TOR", "VAN", "VGK",
    "WSH", "WPG",
]

_TEAM_NAMES: dict[str, str] = {}

# Same fail-fast circuit breaker as the NBA source: a short per-request
# timeout, and bail out after a run of consecutive failures rather than
# grinding through all ~32 x N requests if ESPN is unreachable.
ESPN_TIMEOUT = 8
CIRCUIT_BREAKER_FAILURES = 8


class _EspnUnreachable(Exception):
    pass


def _canon(abbr: str) -> str:
    a = (abbr or "").strip().upper()
    return CANON.get(a, a)


def _espn_season_years(start: str, end: str) -> list[int]:
    # ESPN labels an NHL season by the year it ENDS (e.g. "2021-22" -> 2022).
    y0 = max(2022, int(start[:4]) + (1 if start[5:7] >= "07" else 0))
    y1 = int(end[:4]) + 1
    return list(range(y0, y1 + 1))


def _fetch_team_season(team: str, season: int) -> list[dict]:
    r = requests.get(
        ESPN_SCHEDULE.format(team=team.lower()),
        params={"season": season},
        headers=HEADERS, timeout=ESPN_TIMEOUT,
    )
    r.raise_for_status()
    return (r.json() or {}).get("events") or []


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out: list[Game] = []
    seen_ids: set[str] = set()
    seasons = _espn_season_years(start, end)
    consecutive_failures = 0
    total_failures = 0
    for team in TEAMS:
        for season in seasons:
            try:
                events = _fetch_team_season(team, season)
                consecutive_failures = 0
            except Exception:
                total_failures += 1
                consecutive_failures += 1
                if consecutive_failures >= CIRCUIT_BREAKER_FAILURES:
                    print(f"  NHL: {consecutive_failures} consecutive ESPN failures — "
                          f"ESPN unreachable, stopping early", flush=True)
                    print(f"  NHL: {len(out)} games fetched before bail-out", flush=True)
                    return out
                continue
            for ev in events:
                try:
                    comp = ev["competitions"][0]
                    if not comp.get("status", {}).get("type", {}).get("completed"):
                        continue
                    date = (ev.get("date") or "")[:10]
                    if not (start[:10] <= date <= end[:10]):
                        continue
                    competitors = comp["competitors"]
                    home = next(c for c in competitors if c.get("homeAway") == "home")
                    away = next(c for c in competitors if c.get("homeAway") == "away")
                    h_abbr = _canon(home["team"]["abbreviation"])
                    a_abbr = _canon(away["team"]["abbreviation"])
                    h_id, a_id = norm(h_abbr), norm(a_abbr)
                    _TEAM_NAMES[h_id] = home["team"].get("displayName", h_abbr)
                    _TEAM_NAMES[a_id] = away["team"].get("displayName", a_abbr)
                    gid = str(ev.get("id") or f"ESPN-NHL-{date}-{h_id}-{a_id}")
                    if gid in seen_ids:
                        continue
                    seen_ids.add(gid)
                    out.append(Game(id=gid, date=f"{date}T00:00:00Z",
                                    home_id=h_id, away_id=a_id,
                                    home_score=int(home["score"]), away_score=int(away["score"])))
                except (KeyError, ValueError, StopIteration, TypeError):
                    continue
            time.sleep(0.15)
    if total_failures:
        print(f"  NHL: {total_failures} ESPN requests failed (non-fatal) — "
              f"continuing with whatever succeeded", flush=True)
    print(f"  NHL: {len(out)} games from ESPN (2021-22 season → today)", flush=True)
    return out


def team_brand() -> dict:
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
