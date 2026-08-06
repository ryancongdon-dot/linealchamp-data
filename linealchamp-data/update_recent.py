#!/usr/bin/env python3
"""
update_recent.py — incremental "catch up" for one or more leagues.

WHY THIS EXISTS
    build_lineage.py rebuilds a league's ENTIRE lineage from its seed year
    (1992 for EPL, 1871 for MLB, ...). That is the right tool for a first
    backfill, but it is pure waste for day-to-day currency: past games never
    change, so re-downloading decades of history every run accomplishes
    nothing — and for a rate-limited source like balldontlie's EPL endpoint,
    that re-download is exactly what dragged CI runs to 3+ hours and drained
    the monthly Actions budget.

    This script does what you'd actually want: it reads the chain already
    published on the Worker, finds who holds the belt and the date of the last
    recorded change, fetches ONLY the games since then (about one to two
    seasons), extends the chain, and re-uploads it. Cheap enough to run on a
    laptop in a couple of minutes — no GitHub Actions minutes required.

USAGE
    export ADMIN_SECRET=...        # authorizes the upload
    export BDL_API_KEY=...         # for NBA / EPL
    export CFBD_API_KEY=...        # for CFB
    python update_recent.py --leagues EPL
    python update_recent.py --leagues NBA,NFL,MLB,NHL,EPL,CFB
    python update_recent.py --leagues EPL --lookback-days 900
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import requests

from lineage import compute_lineage, norm

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
DEFAULT_BASE = "https://linealchamp-api.ryan-congdon.workers.dev"
SUPPORTED = ["NBA", "NFL", "MLB", "NHL", "EPL", "CFB"]

# How far back before the last recorded change to start fetching. Wide enough
# to catch the tail of a season that spans a calendar-year boundary (e.g. an
# EPL season labeled N runs Aug N -> May N+1) plus slack. Overlap is harmless:
# already-known games are de-duplicated by id.
DEFAULT_LOOKBACK_DAYS = 550


def load_source(league: str):
    mod = f"sources.{league.lower()}"
    return __import__(mod, fromlist=["fetch_all_games"])


def _get(base: str, path: str) -> dict:
    r = requests.get(f"{base}{path}", timeout=90)
    r.raise_for_status()
    return r.json()


def _post(base: str, path: str, league: str, body: dict, secret: str) -> bool:
    r = requests.post(
        f"{base}{path}?league={league}",
        headers={"x-admin-secret": secret, "content-type": "application/json"},
        data=json.dumps(body),
        timeout=120,
    )
    if r.ok:
        print(f"  {league:4} ✓ {path}  {r.text[:120]}")
        return True
    print(f"  {league:4} ✗ {path}  {r.status_code}  {r.text[:200]}", file=sys.stderr)
    return False


def update_one(league: str, base: str, secret: str, lookback_days: int) -> bool:
    print(f"\n=== {league} ===", flush=True)

    # 1. Read the chain already on the site.
    try:
        chain = _get(base, f"/api/lineage?league={league}")
    except Exception as exc:
        print(f"  couldn't read existing chain: {exc}", file=sys.stderr)
        return False
    changes = sorted(chain.get("changes") or [], key=lambda c: c["date"])
    if not changes:
        print("  no existing chain on the site — run build_lineage.py once for "
              "the first backfill, then this script keeps it current.", file=sys.stderr)
        return False

    current = chain.get("currentChamp") or changes[-1]["to"]
    last_date = changes[-1]["date"][:10]
    print(f"  current champ: {current}  (chain through {last_date}, "
          f"{len(changes)} changes)", flush=True)

    # 2. Fetch ONLY games from a margin before the last change to today.
    start = (date.fromisoformat(last_date) - timedelta(days=lookback_days)).isoformat()
    end = date.today().isoformat()
    src = load_source(league)
    games = src.fetch_all_games(start=start, end=end, cache_dir=CACHE_DIR / league)
    # Only games on/after the last recorded change can extend the chain.
    games = [g for g in games if g.date[:10] >= last_date]
    print(f"  fetched {len(games)} games since {last_date}", flush=True)

    # 3. Walk forward from the current holder (seeded, no history refetch).
    _, new_changes, new_events = compute_lineage(
        games, seed_team=norm(current), seed_date=f"{last_date}T00:00:00Z"
    )

    have_ids = {c.get("gameId") for c in changes if c.get("gameId")}
    fresh = [
        c.to_json() for c in new_changes
        if not c.seed and c.gameId and c.gameId not in have_ids
    ]
    if not fresh:
        print("  already up to date — no new belt changes.", flush=True)
        # Still bump asOfDate so the site shows it's current.
        merged_changes = changes
    else:
        print(f"  {len(fresh)} new belt change(s); newest champ: {fresh[-1]['to']}",
              flush=True)
        merged_changes = changes + fresh

    final_champ = merged_changes[-1]["to"] if merged_changes else current

    # 4. Re-upload the full (small) chain — fetch was cheap, upload is tiny.
    lineage_body = {
        "seedTeam": chain.get("seedTeam"),
        "seedDate": chain.get("seedDate"),
        "asOfDate": end,
        "currentChamp": final_champ,
        "changes": merged_changes,
    }
    ok = _post(base, "/admin/upload-lineage", league, lineage_body, secret)

    # 5. Append any new title-fight events (best effort; lineage is what the
    #    hero/current-champ display depends on).
    if new_events:
        try:
            existing = _get(base, f"/api/events?league={league}").get("events") or []
        except Exception:
            existing = []
        ev_ids = {e.get("gameId") for e in existing if e.get("gameId")}
        fresh_ev = [e.to_json() for e in new_events
                    if e.gameId and e.gameId not in ev_ids]
        if fresh_ev:
            events_body = {"asOfDate": end, "events": existing + fresh_ev}
            ok = _post(base, "/admin/upload-events", league, events_body, secret) and ok
            print(f"  +{len(fresh_ev)} new events", flush=True)

    return ok


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default=DEFAULT_BASE)
    p.add_argument("--admin-secret", default=os.environ.get("ADMIN_SECRET", ""))
    p.add_argument("--leagues", default="EPL")
    p.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    args = p.parse_args()

    if not args.admin_secret:
        print("ADMIN_SECRET is required (env var or --admin-secret).", file=sys.stderr)
        return 2

    leagues = [L.strip().upper() for L in args.leagues.split(",") if L.strip()]
    bad = [L for L in leagues if L not in SUPPORTED]
    if bad:
        print(f"Unsupported leagues: {bad}", file=sys.stderr)
        return 2

    all_ok = True
    for L in leagues:
        try:
            all_ok = update_one(L, args.base_url, args.admin_secret, args.lookback_days) and all_ok
        except Exception:
            import traceback
            print(f"  ✗ {L} failed:", file=sys.stderr)
            traceback.print_exc()
            all_ok = False

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
