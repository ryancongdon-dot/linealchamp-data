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
    p.add_argument("--leagues", default="NBA,NFL,MLB,NHL,EPL,CFB,BOXHW")
    p.add_argument("--skip-events", action="store_true",
                   help="Only push lineage (small); skip events (large).")
    p.add_argument("--only-events", action="store_true",
                   help="Only push events; skip lineage.")
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
                ok = _post(args.base_url, "/admin/upload-lineage", L, body, args.admin_secret)
                all_ok = all_ok and ok

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
