#!/usr/bin/env python3
"""
Uploads the hand-curated boxing lineages (boxing/lineage-BOX*.json) to the
Worker's KV: static lineage, derived events, and fighter display names.

Boxing has no live-data adapter — these chains only change when a lineal
champion actually loses or the files here are edited, so this runs on demand
(or via the upload-boxing GitHub workflow whenever boxing/ changes on main).

USAGE
    export ADMIN_SECRET=...
    python boxing/upload_boxing.py
    python boxing/upload_boxing.py --leagues BOXMW,BOXWW
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = "https://linealchamp-api.ryan-congdon.workers.dev"


def _post(base: str, path: str, params: dict, body: dict, secret: str) -> bool:
    r = requests.post(
        f"{base}{path}",
        params=params,
        headers={"x-admin-secret": secret, "content-type": "application/json"},
        data=json.dumps(body),
        timeout=120,
    )
    tag = params.get("league") or body.get("league")
    if r.ok:
        print(f"  {tag:7} ✓ {path}  {r.text[:100]}")
        return True
    print(f"  {tag:7} ✗ {path}  {r.status_code}  {r.text[:200]}", file=sys.stderr)
    return False


def events_from_changes(changes: list[dict]) -> list[dict]:
    """Every real transfer is a title fight the old champ lost. Vacancy and
    seed entries (from == null) aren't fights, so they carry no event."""
    out = []
    for i, c in enumerate(changes):
        if not c.get("from") or c.get("to") == "VACANT":
            continue
        out.append({
            "date": c["date"],
            "gameId": f"BOX-{c.get('to')}-{i}",
            "champ": c["from"],
            "opponent": c["to"],
            "champScore": None,
            "oppScore": None,
            "score": c.get("score") or "",
            "result": "L",
            "change": True,
        })
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default=DEFAULT_BASE)
    p.add_argument("--admin-secret", default=os.environ.get("ADMIN_SECRET", ""))
    p.add_argument("--leagues", default="", help="Comma-separated subset (default: every lineage-*.json here)")
    args = p.parse_args()

    if not args.admin_secret:
        print("ADMIN_SECRET is required (env var or --admin-secret).", file=sys.stderr)
        return 2

    wanted = {L.strip().upper() for L in args.leagues.split(",") if L.strip()}
    files = sorted(HERE.glob("lineage-BOX*.json"))
    if not files:
        print("No boxing/lineage-BOX*.json files found.", file=sys.stderr)
        return 2

    all_ok = True
    for f in files:
        data = json.loads(f.read_text())
        league = data["league"]
        if wanted and league not in wanted:
            continue

        lineage_body = {
            "seedTeam": data.get("seedTeam"),
            "seedDate": data.get("seedDate"),
            "asOfDate": data.get("asOfDate"),
            "currentChamp": data["currentChamp"],
            "changes": data["changes"],
        }
        ok = _post(args.base_url, "/admin/upload-lineage", {"league": league}, lineage_body, args.admin_secret)

        events_body = {
            "asOfDate": data.get("asOfDate"),
            "events": events_from_changes(data["changes"]),
        }
        ok = _post(args.base_url, "/admin/upload-events", {"league": league}, events_body, args.admin_secret) and ok

        brand = data.get("brand") or {}
        if brand:
            brand_body = {
                "league": league,
                "map": {code: {"name": name} for code, name in brand.items()},
            }
            ok = _post(args.base_url, "/admin/brand/bulk", {}, brand_body, args.admin_secret) and ok

        all_ok = all_ok and ok

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
