"""
Shared helpers for source modules.

The bug these exist to fix: every source caches its raw downloads forever.
A season file fetched mid-season (say, May 2025) gets reused verbatim by a
build a year later, silently dropping every game played after the fetch.
That is exactly how the live site ended up with EPL frozen in April 2025
and CFB missing the entire CFP.

Rule: a cache file is only trustworthy if the window of games it covers
ended comfortably BEFORE the file was written — i.e. the window can no
longer grow. Anything covering dates near or after its own fetch time must
be refetched.
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

# Days of slack between a window's end and the cache write time before we
# trust the file. Covers timezone skew and sources that publish results late.
_MARGIN_DAYS = 2

# Games this close to the build's as-of date must carry an explicit "final"
# status to be counted — otherwise an in-progress game's partial score gets
# baked into the lineage (the 5-3 "NBA game" bug).
RECENT_DAYS = 10

_FINAL_TOKENS = ("final", "ft", "full")


def cache_is_complete(path: Path, window_end: str) -> bool:
    """True iff `path` exists and covers a window that ended at least
    _MARGIN_DAYS before the file was last written (so it cannot be stale)."""
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        end = date.fromisoformat(window_end[:10])
    except ValueError:
        return False
    written = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).date()
    return end <= written - timedelta(days=_MARGIN_DAYS)


def looks_final(status: object) -> bool:
    """True if a source's status field says the game is finished."""
    s = str(status or "").lower()
    return any(t in s for t in _FINAL_TOKENS)


def is_recent(game_date: str, as_of: str, days: int = RECENT_DAYS) -> bool:
    """True if game_date falls within `days` of the build's as-of date —
    the zone where a game might still be in progress."""
    try:
        g = date.fromisoformat(game_date[:10])
        a = date.fromisoformat(as_of[:10])
    except ValueError:
        return True  # unparseable date: treat as recent, i.e. be strict
    return g >= a - timedelta(days=days)


def get_with_backoff(
    url: str,
    params: dict,
    headers: dict,
    *,
    timeout: int = 30,
    max_retries: int = 12,
    base_delay: float = 5,
    max_delay: float = 60,
    label: str = "",
) -> requests.Response:
    """GET with exponential backoff on 429, logging every retry.

    balldontlie's free tier rate-limits hard enough that a naive fixed
    8-second retry (the original behavior) could spend HOURS silently
    re-hitting the same 429 for one page — that's what made a single NBA
    backfill run past a 2-hour CI timeout with no visibility into why.
    Backing off exponentially cuts the number of wasted requests, the
    per-retry print gives visibility in logs, and the retry cap raises
    instead of hanging forever — the caller's per-year/per-season try/except
    already treats a raised error as "skip this window", so one skipped
    page beats a run that never finishes.
    """
    delay = base_delay
    for attempt in range(1, max_retries + 1):
        r = requests.get(url, params=params, headers=headers, timeout=timeout)
        if r.status_code == 429:
            print(
                f"  {label}: rate limited (429), attempt {attempt}/{max_retries}, "
                f"backing off {delay:.0f}s",
                flush=True,
            )
            time.sleep(delay)
            delay = min(delay * 2, max_delay)
            continue
        return r
    raise RuntimeError(f"{label}: exceeded {max_retries} retries on 429 rate limiting")
