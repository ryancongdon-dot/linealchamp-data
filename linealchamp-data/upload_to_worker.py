#!/usr/bin/env python3
"""
Uploads output/{lineage,events}-<LEAGUE>.json to the Worker's KV.

Endpoints used (added in the new worker.js):
    POST /admin/upload-lineage?league=X   body = output/lineage-<X>.json
    POST /admin/upload-events?league=X    body = output/events-<X>.json

Run AFTER build_lineage.py and AFTER you've deployed the new worker.js.
Re-run any time you want to refresh the static historical data; the Worker
reads the latest copy from KV every request.

USAGE
    export ADMIN_SECRET=...
    python upload_to_worker.py
    # or with options:
    python upload_to_worker.py --leagues NBA,NFL --skip-events
    python upload_to_worker.py --base-url https://linealchamp-api.ryan-congdon.workers.dev
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "output"
DEFAULT_BASE = "https://linealchamp-api.ryan-congdon.workers.dev"

# Do-no-harm floor: refuse to overwrite the site's data with a lineage that
# is drastically smaller than what a healthy build produces. This exists
# because a build once ran with Retrosheet unreachable, produced an MLB
# "chain" whose belt never left the 1871 seed team, and shipped it straight
# over months of good data — the site showed Philadelphia Athletics (1871)
# as current champion. Values are ~half of each league's known-good change
# count (NBA 3130, MLB 9059, NHL 3368, CFB 316, NFL 538), so a legitimate
# rebuild always clears the bar and a gutted one never does.
MIN_CHANGES = {
    "NBA": 1500,
    "NFL": 250,
    "MLB": 4000,
    "NHL": 1500,
    "EPL": 150,
    "CFB": 150,
}


def _post(base: str, path: str, league: str, body: dict, secret: str) -> bool:
    url = f"{base}{path}?league={league}"
    r = requests.post(
        url,
        headers={
            "x-admin-secret": secret,
            "content-type": "application/json",
        },
        data=json.dumps(body),
        timeout=120,
    )
    if r.ok:
        print(f"  {league:4} ✓ {path}  {r.text[:120]}")
        return True
    print(f"  {league:4} ✗ {path}  {r.status_code}  {r.text[:200]}", file=sys.stderr)
    return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default=DEFAULT_BASE)
    p.add_argument("--admin-secret", default=os.environ.get("ADMIN_SECRET", ""))
    p.add_argument("--leagues", default="NBA,NFL,MLB,NHL,EPL,CFB")
    p.add_argument("--skip-events", action="store_true",
                   help="Only push lineage (small); skip events (large).")
    p.add_argument("--only-events", action="store_true",
                   help="Only push events; skip lineage.")
    p.add_argument("--force", action="store_true",
                   help="Bypass the MIN_CHANGES sanity floor (use only when "
                        "you have verified the small output is correct).")
    args = p.parse_args()

    if not args.admin_secret:
        print("ADMIN_SECRET is required (env var or --admin-secret).", file=sys.stderr)
        return 2

    leagues = [L.strip().upper() for L in args.leagues.split(",") if L.strip()]
    all_ok = True
    for L in leagues:
        if not args.only_events:
            f = OUTPUT / f"lineage-{L}.json"
            if not f.exists():
                print(f"  {L}: missing {f} — run build_lineage.py first", file=sys.stderr)
                all_ok = False
            else:
                body = json.loads(f.read_text())
                n_changes = len(body.get("changes") or [])
                floor = MIN_CHANGES.get(L, 50)
                if n_changes < floor and not args.force:
                    print(
                        f"  {L}: REFUSING upload — only {n_changes} changes "
                        f"(floor {floor}). The source fetch was almost "
                        f"certainly incomplete; uploading would overwrite "
                        f"good site data with a gutted chain. Fix the fetch "
                        f"or pass --force if this is genuinely correct.",
                        file=sys.stderr,
                    )
                    all_ok = False
                    continue  # don't upload this league's events either
                ok = _post(args.base_url, "/admin/upload-lineage", L, body, args.admin_secret)
                all_ok = all_ok and ok
                # If the build shipped a display-name map, push it too so the
                # site shows real club names, not normalized codes.
                brand = body.get("brand")
                if ok and brand:
                    r = requests.post(
                        f"{args.base_url}/admin/brand/bulk",
                        headers={"x-admin-secret": args.admin_secret,
                                 "content-type": "application/json"},
                        data=json.dumps({"league": L, "map": brand}),
                        timeout=120,
                    )
                    print(f"  {L:4} {'✓' if r.ok else '✗'} /admin/brand/bulk  "
                          f"{r.status_code}  {r.text[:80]}")

        if not args.skip_events:
            f = OUTPUT / f"events-{L}.json"
            if not f.exists():
                print(f"  {L}: missing {f} (events) — skipping", file=sys.stderr)
            else:
                body = json.loads(f.read_text())
                size_mb = f.stat().st_size / (1024 * 1024)
                if size_mb > 24:
                    print(
                        f"  {L}: events file is {size_mb:.1f} MB — Cloudflare KV "
                        f"caps a single value at 25 MB. Skipping.",
                        file=sys.stderr,
                    )
                    all_ok = False
                    continue
                ok = _post(args.base_url, "/admin/upload-events", L, body, args.admin_secret)
                all_ok = all_ok and ok

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
