"""
NHL source — the NHL's own public schedule API, live and self-updating.

hockey-reference.com (the original source) returns HTTP 403 to automated
requests, and ESPN's site API turned out to be blocked from BOTH this dev
environment and GitHub Actions runners (a fetch there logged "8 consecutive
ESPN request failures" in ~5 seconds — a real block, not a fluke). This source
uses `api-web.nhle.com` instead — the NHL's own official API, already proven
reachable in production: it's the exact endpoint worker.js's fetchNHLRecent()
uses every hour for the site's live "today's games" cron. No API key needed.

    GET https://api-web.nhle.com/v1/schedule/<YYYY-MM-DD>
    -> { "gameWeek": [ { "date": ..., "games": [ {...} ] }, ... ] }

One call returns the whole WEEK containing that date, so we step by 7 days
rather than 1 — far fewer requests than a per-team, per-season crawl.

No frozen historical base exists for NHL (538 never published one; the NHL's
own deep-history statsapi was retired in 2024), so — same as before — this
deliberately starts the chain at the 2021-22 season, the point the league
settled at its current 32-team footprint, rather than guess at two decades of
franchise relocations (Atlanta -> Winnipeg, Phoenix -> Arizona -> Utah) without
being able to verify the mapping. Extending further back is a separate,
deliberate addition once a reliable bulk source for 1917-2021 is available.
"""

from __future__ import annotations

from pathlib import Path

import requests

from lineage import Game, norm

# No historical base — the chain auto-seeds from the first game in the fetch
# window (compute_lineage treats SEED_TEAM=None as "seed from the first
# game's winner").
SEED_TEAM = None
SEED_DATE = "2021-10-01"  # 2021-22 season start (informational only)

API_URL = "https://api-web.nhle.com/v1/schedule/{date}"
HEADERS = {"User-Agent": "linealchamp-data/1.0 (historical backfill)"}
ESPN_TIMEOUT = 15

# api-web abbreviation -> full display name (ported from worker.js's
# NHL_ABBREV_TO_NAME, which the Worker's own live cron already uses).
ABBREV_TO_NAME = {
    "ANA": "Anaheim Ducks", "BOS": "Boston Bruins", "BUF": "Buffalo Sabres",
    "CGY": "Calgary Flames", "CAR": "Carolina Hurricanes", "CHI": "Chicago Blackhawks",
    "COL": "Colorado Avalanche", "CBJ": "Columbus Blue Jackets", "DAL": "Dallas Stars",
    "DET": "Detroit Red Wings", "EDM": "Edmonton Oilers", "FLA": "Florida Panthers",
    "LAK": "Los Angeles Kings", "MIN": "Minnesota Wild", "MTL": "Montreal Canadiens",
    "NSH": "Nashville Predators", "NJD": "New Jersey Devils", "NYI": "New York Islanders",
    "NYR": "New York Rangers", "OTT": "Ottawa Senators", "PHI": "Philadelphia Flyers",
    "PIT": "Pittsburgh Penguins", "SJS": "San Jose Sharks", "SEA": "Seattle Kraken",
    "STL": "St. Louis Blues", "TBL": "Tampa Bay Lightning", "TOR": "Toronto Maple Leafs",
    "VAN": "Vancouver Canucks", "VGK": "Vegas Golden Knights", "WSH": "Washington Capitals",
    "WPG": "Winnipeg Jets", "UTA": "Utah Mammoth",
}

_TEAM_NAMES: dict[str, str] = {}


def _add_days(iso: str, n: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def _team_id(t: dict) -> str:
    abbr = str(t.get("abbrev") or t.get("triCode") or "").upper()
    name = ABBREV_TO_NAME.get(abbr) or t.get("name", {}).get("default") or abbr
    code = norm(name)
    _TEAM_NAMES[code] = name
    return code


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    out: list[Game] = []
    seen_ids: set[str] = set()
    cur = start[:10]
    end10 = end[:10]
    consecutive_failures = 0
    total_failures = 0
    while cur <= end10:
        try:
            r = requests.get(API_URL.format(date=cur), headers=HEADERS, timeout=ESPN_TIMEOUT)
            r.raise_for_status()
            j = r.json() or {}
            consecutive_failures = 0
        except Exception:
            total_failures += 1
            consecutive_failures += 1
            if consecutive_failures >= 6:
                print(f"  NHL: {consecutive_failures} consecutive api-web failures — "
                      f"stopping early ({len(out)} games fetched so far)", flush=True)
                return out
            cur = _add_days(cur, 7)
            continue
        for day in (j.get("gameWeek") or []):
            for g in (day.get("games") or []):
                state = str(g.get("gameState") or "").upper()
                if state != "OFF" and "FINAL" not in state:
                    continue
                home, away = g.get("homeTeam") or {}, g.get("awayTeam") or {}
                hs, as_ = home.get("score"), away.get("score")
                if hs is None or as_ is None:
                    continue
                date_ = (g.get("startTimeUTC") or day.get("date") or cur)[:10]
                if not (start[:10] <= date_ <= end10):
                    continue
                gid = f"NHL-{g.get('id') or date_ + '-' + str(home.get('abbrev')) + '-' + str(away.get('abbrev'))}"
                if gid in seen_ids:
                    continue
                seen_ids.add(gid)
                out.append(Game(id=gid, date=f"{date_}T00:00:00Z",
                                home_id=_team_id(home), away_id=_team_id(away),
                                home_score=int(hs), away_score=int(as_)))
        cur = _add_days(cur, 7)
    if total_failures:
        print(f"  NHL: {total_failures} api-web requests failed (non-fatal) — "
              f"continuing with whatever succeeded", flush=True)
    print(f"  NHL: {len(out)} games from api-web.nhle.com (2021-22 season → today)", flush=True)
    return out


def team_brand() -> dict:
    return {code: {"name": name} for code, name in sorted(_TEAM_NAMES.items())}
