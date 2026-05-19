#!/usr/bin/env python3
"""
build_lineage.py — one-shot offline backfill for the lineal champion Worker.

For each requested league, fetches the full game history from authoritative
sources, runs the lineage algorithm, and writes two JSON files per league:

    output/lineage-<LEAGUE>.json   small  (belt changes only — inline in Worker)
    output/events-<LEAGUE>.json    large  (every game involving a holder — upload to R2)

USAGE
    # First time, all leagues:
    python build_lineage.py --leagues NBA,NFL,MLB,NHL,EPL,CFB

    # Just CFB, with a specific as-of date:
    python build_lineage.py --leagues CFB --as-of 2026-05-17

    # Probe one source's response shape (helpful when adapters fail):
    python build_lineage.py --probe NFL --year 2023

ENV
    BDL_API_KEY     balldontlie API key (NBA, NFL, EPL)
    CFBD_API_KEY    collegefootballdata.com key (CFB)

OUTPUTS are deterministic given the same inputs and cache — safe to re-run.

LIMITATIONS
    Scrapers cannot be tested from within the original development sandbox; you
    must run this on a machine with outbound network access. If a source's
    response shape has drifted, the per-league source module is where to patch
    (sources/<league>.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import date, datetime, timezone
from pathlib import Path

from lineage import compute_lineage, Game

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"
CACHE_DIR = ROOT / "cache"
SUPPORTED = ["NBA", "NFL", "MLB", "NHL", "EPL", "CFB"]


def load_source(league: str):
    """Lazy-import the source module so a broken one doesn't take the rest down."""
    mod_name = f"sources.{league.lower()}"
    return __import__(mod_name, fromlist=["fetch_all_games", "SEED_TEAM", "SEED_DATE"])


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        json.dump(payload, f, indent=2, default=str)


def build_one_league(league: str, as_of: str) -> dict:
    print(f"\n=== {league} ===", flush=True)
    src = load_source(league)

    games = src.fetch_all_games(
        start=src.SEED_DATE,
        end=as_of,
        cache_dir=CACHE_DIR / league,
    )

    if not games:
        print(f"  no games returned by {league} source — skipping", flush=True)
        return {"league": league, "ok": False, "reason": "no games"}

    print(f"  fetched {len(games)} games", flush=True)

    seed_team = getattr(src, "SEED_TEAM", None)
    seed_date = getattr(src, "SEED_DATE", None)
    vacancy_days = getattr(src, "VACANCY_DAYS", None)

    current, changes, events = compute_lineage(
        games, seed_team=seed_team, seed_date=seed_date, vacancy_days=vacancy_days
    )

    lineage_payload = {
        "league": league,
        "seedTeam": seed_team,
        "seedDate": seed_date,
        "asOfDate": as_of,
        "currentChamp": current,
        "changes": [c.to_json() for c in changes],
    }
    events_payload = {
        "league": league,
        "asOfDate": as_of,
        "events": [e.to_json() for e in events],
    }

    write_json(OUTPUT_DIR / f"lineage-{league}.json", lineage_payload)
    write_json(OUTPUT_DIR / f"events-{league}.json", events_payload)

    print(
        f"  → {len(changes)} belt changes, {len(events)} events, "
        f"current champ: {current}",
        flush=True,
    )
    return {
        "league": league,
        "ok": True,
        "changes": len(changes),
        "events": len(events),
        "current": current,
    }


def probe(league: str, year: int) -> None:
    """Dump one game's parsed shape — useful for debugging a misbehaving source."""
    src = load_source(league)
    start = f"{year}-01-01"
    end = f"{year}-12-31"
    games = src.fetch_all_games(start=start, end=end, cache_dir=CACHE_DIR / league)
    if not games:
        print(f"no games for {league} {year}")
        return
    print(json.dumps(games[0].__dict__, indent=2, default=str))
    print(f"\n(total: {len(games)} games)")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--leagues",
        default=",".join(SUPPORTED),
        help="Comma-separated league codes (NBA,NFL,MLB,NHL,EPL,CFB)",
    )
    p.add_argument(
        "--as-of",
        default=date.today().isoformat(),
        help="Last date to include (YYYY-MM-DD). Default: today.",
    )
    p.add_argument("--probe", help="Probe one league's source and exit")
    p.add_argument("--year", type=int, help="Year for --probe")
    args = p.parse_args()

    if args.probe:
        if not args.year:
            print("--year is required with --probe", file=sys.stderr)
            return 2
        probe(args.probe.upper(), args.year)
        return 0

    leagues = [L.strip().upper() for L in args.leagues.split(",") if L.strip()]
    bad = [L for L in leagues if L not in SUPPORTED]
    if bad:
        print(f"Unsupported leagues: {bad}", file=sys.stderr)
        return 2

    results = []
    for L in leagues:
        try:
            results.append(build_one_league(L, args.as_of))
        except Exception:
            print(f"  ✗ {L} failed:", flush=True)
            traceback.print_exc()
            results.append({"league": L, "ok": False, "reason": "exception"})

    print("\n=== summary ===")
    for r in results:
        if r.get("ok"):
            print(
                f"  {r['league']:4} ✓ {r['changes']:>5} changes, "
                f"{r['events']:>7} events, champ={r['current']}"
            )
        else:
            print(f"  {r['league']:4} ✗ {r.get('reason', 'unknown')}")

    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
