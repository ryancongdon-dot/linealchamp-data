"""
EPL source — balldontlie /epl/v1/games + /epl/v1/teams.

BDL EPL game shape (verified from live probe):
    {
      "id": 1,
      "week": 38,
      "kickoff": "1993-05-11T18:45:00.000Z",
      "home_team_id": 1,
      "away_team_id": 45,
      "home_score": 1,
      "away_score": 3,
      "status": "C",
      "season": 1992,
      ...
    }

Note: teams are referenced by integer ID only. The names are fetched from
/epl/v1/teams and joined locally. Also: BDL ignores the `seasons[]` query
parameter and always returns the entire dataset, so we paginate once and
group locally by season.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import requests

from lineage import Game, norm

SEED_TEAM = None  # let first game's winner seed
SEED_DATE = "1992-08-15"

BDL_GAMES_URL = "https://api.balldontlie.io/epl/v1/games"
BDL_TEAMS_URL = "https://api.balldontlie.io/epl/v1/teams"
RATE_DELAY_SEC = 0.6


def _api_key() -> str:
    k = os.environ.get("BDL_API_KEY")
    if not k:
        raise RuntimeError("BDL_API_KEY env var required for EPL source.")
    return k


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Accept": "application/json",
    }


def _fetch_teams(cache_dir: Path) -> dict[int, str]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf = cache_dir / "teams.json"
    if cf.exists():
        try:
            raw = json.loads(cf.read_text())
            return {int(t["id"]): _team_name(t) for t in raw}
        except Exception:
            pass

    # /epl/v1/teams requires a season param and returns only that season's 20
    # clubs. Walk every EPL season so relegated/historical clubs are included.
    by_id: dict[int, dict] = {}
    for season in range(1992, 2025):
        for attempt in range(3):
            r = requests.get(
                BDL_TEAMS_URL,
                params={"season": str(season)},
                headers=_headers(),
                timeout=30,
            )
            if r.status_code == 429:
                time.sleep(8)
                continue
            if r.status_code >= 400:
                # Some seasons may legitimately error; skip and continue.
                print(
                    f"    EPL /teams season {season}: {r.status_code} {r.text[:120]}",
                    flush=True,
                )
                break
            j = r.json()
            data = j.get("data", []) if isinstance(j, dict) else j
            for t in data:
                tid = t.get("id")
                if tid is not None:
                    by_id[int(tid)] = t
            time.sleep(RATE_DELAY_SEC)
            break
    all_teams = list(by_id.values())
    if not all_teams:
        raise RuntimeError("BDL EPL /teams returned no usable data across any season")

    cf.write_text(json.dumps(all_teams))
    return {int(t["id"]): _team_name(t) for t in all_teams}


def _team_name(t: dict) -> str:
    for k in ("short_name", "abbreviation", "name", "full_name"):
        v = t.get(k)
        if v:
            return norm(v)
    return f"TEAM-{t.get('id')}"


def _fetch_all_games(cache_dir: Path) -> list[dict]:
    cf = cache_dir / "all-games.json"
    if cf.exists() and cf.stat().st_size > 100:
        try:
            return json.loads(cf.read_text())
        except Exception:
            pass

    all_items: list[dict] = []
    cursor: Optional[str] = None
    safety = 0
    while True:
        params = {"per_page": "100"}
        if cursor is not None:
            params["cursor"] = str(cursor)
        r = requests.get(BDL_GAMES_URL, params=params, headers=_headers(), timeout=30)
        if r.status_code == 429:
            time.sleep(8)
            continue
        if r.status_code in (401, 403):
            raise RuntimeError(
                f"BDL EPL returned {r.status_code} — your BDL_API_KEY may not "
                f"have the EPL endpoint enabled. Response: {r.text[:200]}"
            )
        r.raise_for_status()
        j = r.json()
        all_items.extend(j.get("data", []))
        nxt = (j.get("meta") or {}).get("next_cursor")
        if not nxt:
            break
        cursor = nxt
        safety += 1
        if safety > 5000:
            break
        time.sleep(RATE_DELAY_SEC)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(all_items))
    return all_items


def fetch_all_games(start: str, end: str, cache_dir: Path) -> list[Game]:
    teams = _fetch_teams(cache_dir)
    print(f"  EPL teams loaded: {len(teams)}", flush=True)

    raw = _fetch_all_games(cache_dir)
    print(f"  EPL raw games fetched: {len(raw)}", flush=True)

    # Clean up any old per-season cache files left over from the prior shape.
    for f in cache_dir.glob("season-*.json"):
        try:
            f.unlink()
        except Exception:
            pass

    out: list[Game] = []
    skipped_no_team = 0
    skipped_no_score = 0
    skipped_date = 0
    for it in raw:
        hid = it.get("home_team_id")
        aid = it.get("away_team_id")
        if hid is None or aid is None:
            skipped_no_team += 1
            continue
        home_name = teams.get(int(hid))
        away_name = teams.get(int(aid))
        if not home_name or not away_name:
            skipped_no_team += 1
            continue
        hs = it.get("home_score")
        as_ = it.get("away_score")
        if hs is None or as_ is None:
            skipped_no_score += 1
            continue
        # Only count completed games (status "C" = completed in BDL EPL data).
        status = it.get("status")
        if status and status not in ("C", "Final", "FT"):
            skipped_no_score += 1
            continue
        d = it.get("kickoff") or it.get("date") or it.get("start_time")
        if not d:
            skipped_date += 1
            continue
        iso_d = d if "T" in d else f"{d}T00:00:00Z"
        if not (start <= iso_d[:10] <= end):
            skipped_date += 1
            continue
        try:
            out.append(
                Game(
                    id=f"BDL-EPL-{it.get('id')}",
                    date=iso_d,
                    home_id=home_name,
                    away_id=away_name,
                    home_score=int(hs),
                    away_score=int(as_),
                )
            )
        except (TypeError, ValueError):
            skipped_no_score += 1

    print(
        f"  EPL kept {len(out)} games "
        f"(skipped: no_team={skipped_no_team}, no_score={skipped_no_score}, "
        f"out_of_range={skipped_date})",
        flush=True,
    )
    return out
